"""LangGraph Agent 状态机 —— plan→retrieve→rerank→answer→reflect（对齐 TS 10 节点）。"""

import json
import logging
from typing import Any, Dict, List, Optional, Literal, Callable, Awaitable, TypedDict

from langchain_core.documents import Document
from langgraph.graph import StateGraph, START, END
from langgraph.graph.state import CompiledStateGraph
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

from src.config import settings
from importlib import import_module

_01_policy = import_module("src.agent.01_policy")
AGENT_SYSTEM_PROMPT = _01_policy.AGENT_SYSTEM_PROMPT

_05_retriever = import_module("src.kb.05_retriever")
retrieve_relevant_chunks = _05_retriever.retrieve_relevant_chunks

from src.utils.llm import chat_model, rerank_model, reflection_model

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------
# 常量
# ---------------------------------------------------------------
FALLBACK_ANSWER = "根据现有的知识库文档，我暂时无法可靠回答这个问题。"
WEB_SEARCH_CANCELLED = "已取消联网搜索。"
WEB_SEARCH_EMPTY = "已尝试联网搜索，但没有检索到足够可靠的公开网页结果。"
WEB_SEARCH_NO_API_KEY = "已确认联网搜索，但服务端尚未配置 TAVILY_API_KEY，暂时无法执行互联网检索。"

# ---------------------------------------------------------------
# 类型
# ---------------------------------------------------------------
WebSearchDecision = Literal["confirm", "cancel"]
RetrievalFallbackReason = Literal["no_retrieval", "low_confidence"]
AnswerSource = Literal["kb", "web", "none"]
ReflectionAction = Literal["accept", "rewrite", "ask_web_search"]
AgentStage = Literal[
    "planning", "retrieving", "reranking", "answering",
    "web_searching", "reflecting",
]

DEFAULT_QUERY_PLAN = {
    "intent": "answer_question",
    "needsKbRetrieval": True,
    "needsWebSearch": False,
    "searchQuery": "",
    "answerStyle": "concise",
    "riskLevel": "low",
}


class AgentState(TypedDict, total=False):
    """Agent 状态 schema，确保 LangGraph 正确合并各节点的返回值。"""
    messages: List[dict]
    queryPlan: dict
    question: str
    docs: List[Document]
    citations: List[dict]
    confidence: float
    fallbackReason: Optional[str]
    shouldAskWebSearch: bool
    answerSource: str
    webResults: List[dict]
    webSearchDecision: Optional[str]
    webSearchError: Optional[str]
    reflectionAction: str
    answer: str

# 全局 checkpointer
_checkpointer: Optional[MemorySaver] = None


def _get_checkpointer() -> MemorySaver:
    global _checkpointer
    if _checkpointer is None:
        _checkpointer = MemorySaver()
    return _checkpointer


# ---------------------------------------------------------------
# 回调类型
# ---------------------------------------------------------------
OnStageCallback = Callable[[AgentStage], Awaitable[None]]
OnTokenCallback = Callable[[str], Awaitable[None]]


# ---------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------
def _get_latest_user_message(messages: List[dict]) -> Optional[dict]:
    for m in reversed(messages):
        if m.get("role") == "user" and m.get("content", "").strip():
            return m
    return None


def _format_history(messages: List[dict]) -> str:
    lines = []
    for m in messages:
        role = "助手" if m.get("role") == "assistant" else "用户"
        lines.append(f"{role}: {m.get('content', '')}")
    return "\n".join(lines)


def _format_kb_context(docs: List[Document]) -> str:
    parts = []
    for i, doc in enumerate(docs):
        source = doc.metadata.get("source", "unknown")
        parts.append(f"资料{i + 1}（{source}）\n{doc.page_content}")
    return "\n\n".join(parts)


def _format_web_context(results: List[dict]) -> str:
    parts = []
    for i, r in enumerate(results):
        parts.append(
            f"网页{i + 1}\n"
            f"标题：{r.get('title', '未命名')}\n"
            f"链接：{r.get('url', '')}\n"
            f"相关度：{r.get('score', 0)}\n"
            f"{r.get('content', '')}"
        )
    return "\n\n".join(parts)


def _build_kb_citations(docs: List[Document]) -> List[dict]:
    seen = set()
    citations = []
    for doc in docs:
        source = doc.metadata.get("source", "unknown_source")
        if source in seen:
            continue
        seen.add(source)
        preview = doc.page_content[:400] + ("..." if len(doc.page_content) > 400 else "")
        citations.append({"source": source, "preview": preview, "type": "kb"})
    return citations


def _truncate_for_rerank(text: str, max_chars: int = 900) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "..."


def _extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    return str(content) if content else ""


# ---------------------------------------------------------------
# LLM-based Rerank（对齐 TS rerankDocsWithLLM）
# ---------------------------------------------------------------
async def _rerank_docs_with_llm(
    query: str,
    docs: List[Document],
    top_k: int,
) -> List[Document]:
    if len(docs) <= 1:
        return docs[:top_k]

    candidates = [
        {"id": i, "text": _truncate_for_rerank(doc.page_content, 900)}
        for i, doc in enumerate(docs)
    ]

    prompt = [
        {
            "role": "system",
            "content": "你是一个 rerank 模型。给定用户问题与候选段落，选择最有助于回答该问题的段落，并按相关性从高到低排序。必须返回 JSON 格式，包含一个 `order` 字段，其值为候选段落的 id 数组。",
        },
        {
            "role": "user",
            "content": json.dumps(
                {"query": query, "topK": top_k, "candidates": candidates},
                ensure_ascii=False,
            ),
        },
    ]

    try:
        resp = await rerank_model.ainvoke(prompt)
        text = _extract_text(resp.content)
        parsed = json.loads(text)
        order = parsed.get("order", [])
    except Exception as e:
        logger.warning(f"Rerank failed: {e}")
        return docs[:top_k]

    seen = set()
    picked = []
    for idx in order:
        if len(picked) >= top_k:
            break
        if not isinstance(idx, int) or idx < 0 or idx >= len(docs):
            continue
        if idx in seen:
            continue
        seen.add(idx)
        picked.append(docs[idx])

    for i, doc in enumerate(docs):
        if len(picked) >= top_k:
            break
        if i not in seen:
            picked.append(doc)

    return picked


# ---------------------------------------------------------------
# Agent 构建
# ---------------------------------------------------------------
def _create_agent_graph(
    on_stage: Optional[OnStageCallback] = None,
    on_token: Optional[OnTokenCallback] = None,
    signal: Optional[Any] = None,
) -> CompiledStateGraph:
    """构建 10 节点 LangGraph 状态机。"""

    async def _assert_not_aborted():
        if signal and hasattr(signal, "aborted") and signal.aborted:
            raise Exception("AbortError")

    async def _plan_query(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("planning")

        messages = state.get("messages", [])
        latest = _get_latest_user_message(messages)

        if not latest:
            return {"queryPlan": DEFAULT_QUERY_PLAN}

        prompt = [
            {
                "role": "system",
                "content": "你是 RAG 问答系统的计划器。根据对话历史生成执行计划，只返回 JSON。",
            },
            {
                "role": "user",
                "content": json.dumps({
                    "task": "判断这个问题应该如何检索和回答。searchQuery 必须是适合向量检索的完整独立问题。",
                    "conversation": messages,
                }, ensure_ascii=False),
            },
        ]

        try:
            resp = await reflection_model.ainvoke(prompt)
            text = _extract_text(resp.content)
            plan = json.loads(text)
            return {
                "queryPlan": {
                    "intent": plan.get("intent", DEFAULT_QUERY_PLAN["intent"]),
                    "needsKbRetrieval": plan.get("needsKbRetrieval", True),
                    "needsWebSearch": plan.get("needsWebSearch", False),
                    "searchQuery": plan.get("searchQuery", latest.get("content", "")),
                    "answerStyle": plan.get("answerStyle", "concise"),
                    "riskLevel": plan.get("riskLevel", "low"),
                }
            }
        except Exception as e:
            logger.warning(f"plan_query 失败: {e}")
            return {
                "queryPlan": {
                    **DEFAULT_QUERY_PLAN,
                    "searchQuery": latest.get("content", ""),
                }
            }

    async def _retrieve(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("retrieving")

        messages = state.get("messages", [])
        plan = state.get("queryPlan", DEFAULT_QUERY_PLAN)
        latest = _get_latest_user_message(messages)
        question = latest.get("content", "").strip() if latest else ""
        search_query = plan.get("searchQuery", question) or question

        if not plan.get("needsKbRetrieval", True):
            return {
                "docs": [], "citations": [], "confidence": 0,
                "fallbackReason": "no_retrieval", "question": question,
                "shouldAskWebSearch": plan.get("needsWebSearch", False),
                "answerSource": "none",
                "webResults": [], "webSearchDecision": None,
                "webSearchError": None, "reflectionAction": "accept",
            }

        candidate_k = (
            max(settings.RERANK_CANDIDATES, settings.RERANK_TOP_K)
            if settings.RERANK_ENABLED
            else settings.RERANK_TOP_K
        )

        result = await retrieve_relevant_chunks(search_query, candidate_k)
        docs = result["docs"]
        confidence = result["confidence"]

        fallback_reason = None
        if not docs:
            fallback_reason = "no_retrieval"
        elif confidence < settings.RETRIEVAL_LOW_CONFIDENCE_THRESHOLD:
            fallback_reason = "low_confidence"

        final_docs = docs
        # 只有无文档时才跳过重排序；低置信度也尝试重排
        if fallback_reason != "no_retrieval" and settings.RERANK_ENABLED and len(docs) > 1:
            if on_stage:
                await on_stage("reranking")
            try:
                final_docs = await _rerank_docs_with_llm(
                    query=search_query,
                    docs=docs,
                    top_k=settings.RERANK_TOP_K,
                )
            except Exception as e:
                logger.warning(f"重排序失败: {e}")
                final_docs = docs[: settings.RERANK_TOP_K]

        if fallback_reason != "no_retrieval":
            final_docs = final_docs[: settings.RERANK_TOP_K]

        citations = _build_kb_citations(final_docs) if final_docs else []

        # 只有无文档或计划明确要求时才走联网搜索确认；低置信度时先让 KB 回答，由反思节点决定是否需要联网
        should_ask_web = plan.get("needsWebSearch", False) or fallback_reason == "no_retrieval"

        return {
            "docs": final_docs, "citations": citations,
            "confidence": confidence, "fallbackReason": fallback_reason,
            "question": question,
            "shouldAskWebSearch": should_ask_web,
            "answerSource": "none",
            "webResults": [], "webSearchDecision": None,
            "webSearchError": None, "reflectionAction": "accept",
        }

    def _ask_web_search(state: dict) -> dict:
        plan = state.get("queryPlan", DEFAULT_QUERY_PLAN)
        fallback = state.get("fallbackReason")

        if plan.get("needsWebSearch"):
            reason_msg = "这个问题可能需要知识库之外的最新或公开信息。"
        elif fallback == "no_retrieval":
            reason_msg = "知识库中没有检索到可用于回答当前问题的内容。"
        else:
            reason_msg = "知识库检索到了内容，但当前结果置信度偏低。"

        question = state.get("question", "")

        decision = interrupt({
            "type": "web_search_confirmation",
            "message": f"{reason_msg} 是否需要改为联网搜索后再生成答案？",
            "question": question,
            "reason": fallback or "low_confidence",
            "confidence": state.get("confidence"),
            "confirmLabel": "确定",
            "cancelLabel": "取消",
        })

        return {
            "webSearchDecision": decision["action"] if isinstance(decision, dict) else decision,
        }

    async def _answer_from_kb(state: dict) -> dict:
        question = state.get("question", "")
        docs = state.get("docs", [])

        if not question or not docs:
            return {"answer": FALLBACK_ANSWER, "answerSource": "none", "citations": []}

        await _assert_not_aborted()
        if on_stage:
            await on_stage("answering")

        plan = state.get("queryPlan", DEFAULT_QUERY_PLAN)
        messages = state.get("messages", [])

        prompt = [
            {"role": "system", "content": AGENT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "\n".join([
                    "以下是对话历史：",
                    _format_history(messages),
                    "",
                    "以下是可用知识库文档上下文：",
                    _format_kb_context(docs),
                    "",
                    f"请只基于这些知识库文档回答最后一个用户问题。回答风格：{plan.get('answerStyle', 'concise')}。风险等级：{plan.get('riskLevel', 'low')}；风险越高，越要保守。",
                ]),
            },
        ]

        answer = ""
        async for chunk in chat_model.astream(prompt):
            await _assert_not_aborted()
            token = _extract_text(chunk.content) if chunk.content else ""
            if token:
                answer += token
                if on_token:
                    await on_token(token)

        answer = answer.strip() or FALLBACK_ANSWER
        return {"answer": answer, "answerSource": "kb", "citations": state.get("citations", [])}

    async def _search_web(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("web_searching")

        question = state.get("question", "")

        if not settings.TAVILY_API_KEY:
            return {"citations": [], "webResults": [], "webSearchError": WEB_SEARCH_NO_API_KEY}

        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=settings.TAVILY_API_KEY)
            response = client.search(query=question, search_depth="advanced", max_results=5)
            await _assert_not_aborted()

            results = response.get("results", [])
            web_results = [
                {
                    "title": r.get("title", ""),
                    "url": r.get("url", ""),
                    "content": r.get("content", ""),
                    "score": r.get("score", 0),
                }
                for r in results
            ]

            citations = [
                {
                    "source": r["title"] or r["url"],
                    "preview": r["content"][:400] + ("..." if len(r.get("content", "")) > 400 else ""),
                    "url": r["url"],
                    "type": "web",
                }
                for r in web_results
            ]

            return {"citations": citations, "webResults": web_results, "webSearchError": None}
        except Exception as e:
            logger.error(f"联网搜索失败: {e}")
            return {"citations": [], "webResults": [], "webSearchError": "联网搜索失败，请稍后重试。"}

    async def _answer_from_web(state: dict) -> dict:
        error = state.get("webSearchError")
        if error:
            return {"answer": error, "answerSource": "none", "citations": []}

        web_results = state.get("webResults", [])
        if not web_results:
            return {"answer": WEB_SEARCH_EMPTY, "answerSource": "none", "citations": []}

        await _assert_not_aborted()
        if on_stage:
            await on_stage("answering")

        messages = state.get("messages", [])

        prompt = [
            {"role": "system", "content": AGENT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "\n".join([
                    "以下是对话历史：",
                    _format_history(messages),
                    "",
                    "以下是联网搜索结果：",
                    _format_web_context(web_results),
                    "",
                    "请优先基于这些联网搜索结果回答最后一个用户问题；如果来源之间存在冲突，请明确说明。",
                ]),
            },
        ]

        answer = ""
        async for chunk in chat_model.astream(prompt):
            await _assert_not_aborted()
            token = _extract_text(chunk.content) if chunk.content else ""
            if token:
                answer += token
                if on_token:
                    await on_token(token)

        answer = answer.strip() or WEB_SEARCH_EMPTY
        return {"answer": answer, "answerSource": "web", "citations": state.get("citations", [])}

    async def _reflect_answer(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("reflecting")

        answer = state.get("answer", "")
        answer_source = state.get("answerSource", "none")
        docs = state.get("docs", [])
        web_results = state.get("webResults", [])

        if not answer.strip() or answer in (
            FALLBACK_ANSWER, WEB_SEARCH_CANCELLED, WEB_SEARCH_EMPTY, WEB_SEARCH_NO_API_KEY,
        ):
            # KB 回答失败时，建议联网搜索
            if answer == FALLBACK_ANSWER and answer_source == "kb":
                return {
                    "reflectionAction": "ask_web_search",
                    "fallbackReason": "low_confidence",
                    "shouldAskWebSearch": True,
                }
            return {"reflectionAction": "accept"}

        context = _format_web_context(web_results) if answer_source == "web" else _format_kb_context(docs)

        if not context.strip():
            new_answer = WEB_SEARCH_EMPTY if answer_source == "web" else FALLBACK_ANSWER
            return {"reflectionAction": "rewrite", "answer": new_answer}

        prompt = [
            {"role": "system", "content": "你是 RAG 答案审查器。检查答案是否严格由给定上下文支持，只返回 JSON。"},
            {
                "role": "user",
                "content": json.dumps({
                    "task": "判断 assistantAnswer 是否完全受到 suppliedContext 支持。若答案包含上下文外断言，返回 rewrite 并给出更保守的 answer。知识库答案明显需要外部信息时可返回 ask_web_search。",
                    "allowedActions": ["accept", "rewrite", "ask_web_search"] if answer_source == "kb" else ["accept", "rewrite"],
                    "answerSource": answer_source,
                    "suppliedContext": context,
                    "assistantAnswer": answer,
                }, ensure_ascii=False),
            },
        ]

        try:
            resp = await rerank_model.ainvoke(prompt)
            text = _extract_text(resp.content)
            reflection = json.loads(text)
            action = reflection.get("action", "accept")

            if answer_source == "web" and action == "ask_web_search":
                action = "rewrite"

            if action == "rewrite":
                new_answer = reflection.get("answer") or (
                    WEB_SEARCH_EMPTY if answer_source == "web" else FALLBACK_ANSWER
                )
                return {"reflectionAction": "rewrite", "answer": new_answer}

            if action == "ask_web_search":
                return {
                    "reflectionAction": "ask_web_search",
                    "fallbackReason": "low_confidence",
                    "shouldAskWebSearch": True,
                }

            return {"reflectionAction": "accept"}
        except Exception as e:
            logger.warning(f"反思失败: {e}")
            return {"reflectionAction": "accept"}

    def _cancel_web_search(state: dict) -> dict:
        return {"answer": WEB_SEARCH_CANCELLED, "answerSource": "none", "citations": []}

    # 构建图
    builder = StateGraph(AgentState)

    builder.add_node("plan_query", _plan_query)
    builder.add_node("retrieve", _retrieve)
    builder.add_node("ask_web_search_confirmation", _ask_web_search)
    builder.add_node("answer_from_kb", _answer_from_kb)
    builder.add_node("search_web", _search_web)
    builder.add_node("answer_from_web", _answer_from_web)
    builder.add_node("reflect_answer", _reflect_answer)
    builder.add_node("cancel_web_search", _cancel_web_search)

    builder.add_edge(START, "plan_query")
    builder.add_edge("plan_query", "retrieve")

    def _route_after_retrieve(state: dict) -> str:
        return "ask_web_search_confirmation" if state.get("shouldAskWebSearch") else "answer_from_kb"

    builder.add_conditional_edges("retrieve", _route_after_retrieve, {
        "ask_web_search_confirmation": "ask_web_search_confirmation",
        "answer_from_kb": "answer_from_kb",
    })

    def _route_after_web_search_confirm(state: dict) -> str:
        return "search_web" if state.get("webSearchDecision") == "confirm" else "cancel_web_search"

    builder.add_conditional_edges("ask_web_search_confirmation", _route_after_web_search_confirm, {
        "search_web": "search_web",
        "cancel_web_search": "cancel_web_search",
    })

    builder.add_edge("answer_from_kb", "reflect_answer")

    def _route_after_reflect(state: dict) -> str:
        return "ask_web_search_confirmation" if state.get("reflectionAction") == "ask_web_search" else END

    builder.add_conditional_edges("reflect_answer", _route_after_reflect, {
        "ask_web_search_confirmation": "ask_web_search_confirmation",
        END: END,
    })

    builder.add_edge("search_web", "answer_from_web")
    builder.add_edge("answer_from_web", "reflect_answer")
    builder.add_edge("cancel_web_search", END)

    return builder.compile(checkpointer=_get_checkpointer())


# ---------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------
async def run_agent(
    messages: List[dict],
    thread_id: str,
    decision: Optional[str] = None,
    on_stage: Optional[OnStageCallback] = None,
    on_token: Optional[OnTokenCallback] = None,
    signal: Optional[Any] = None,
) -> dict:
    """运行 Agent 状态机。"""
    graph = _create_agent_graph(on_stage=on_stage, on_token=on_token, signal=signal)
    config = {"configurable": {"thread_id": thread_id}}

    if decision:
        result = await graph.ainvoke(Command(resume={"action": decision}), config)
    else:
        result = await graph.ainvoke({"messages": messages}, config)

    # 检查中断
    interrupt_data = result.get("__interrupt__", [])
    if interrupt_data:
        interrupt_value = interrupt_data[0]
        if hasattr(interrupt_value, "value"):
            return {"type": "interrupt", "interrupt": interrupt_value.value}
        return {"type": "interrupt", "interrupt": {
            "type": "web_search_confirmation",
            "message": "是否需要联网搜索？",
        }}

    return {
        "type": "done",
        "answer": result.get("answer", "").strip() or FALLBACK_ANSWER,
        "citations": result.get("citations", []),
    }
