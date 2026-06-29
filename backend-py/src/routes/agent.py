"""Agent 对话 SSE 路由。"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from importlib import import_module
run_agent = import_module("src.agent.02_agent").run_agent

_03_memory = import_module("src.agent.03_memory")
append_to_history = _03_memory.append_to_history
ensure_thread_id = _03_memory.ensure_thread_id
get_history = _03_memory.get_history

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatBody(BaseModel):
    message: Optional[str] = None
    threadId: Optional[str] = None
    webSearchDecision: Optional[str] = None  # "confirm" | "cancel"


def _sse(event: str, payload: dict) -> str:
    """构建 SSE 事件字符串。"""
    data = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {data}\n\n"


@router.post("/chat")
async def chat(body: ChatBody, request: Request):
    """POST /agent/chat — SSE 流式对话端点。"""
    message = body.message
    thread_id_in = body.threadId
    web_search_decision = body.webSearchDecision

    is_resume = web_search_decision in ("confirm", "cancel")

    if not is_resume and (not message or not message.strip()):
        return {"ok": False, "message": "Message is required"}

    if is_resume and not thread_id_in:
        return {"ok": False, "message": "threadId is required when resuming"}

    disconnected = False

    async def event_generator():
        nonlocal disconnected

        try:
            # 确保 threadId
            thread_id = await ensure_thread_id(thread_id_in)
            yield _sse("thread", {"threadId": thread_id})

            # 使用队列收集 Agent 回调事件
            queue: asyncio.Queue = asyncio.Queue()

            async def on_stage(stage: str):
                await queue.put(("status", {"stage": stage}))

            async def on_token(token: str):
                await queue.put(("chunk", {"content": token}))

            if is_resume:
                yield _sse("status", {
                    "stage": "web_searching" if web_search_decision == "confirm" else "cancelling",
                })
            else:
                # 获取历史
                history = await get_history(thread_id)
                user_msg = {"role": "user", "content": message.strip()}
                await append_to_history(thread_id, user_msg)
                messages_for_agent = [*history, user_msg]

                yield _sse("status", {"stage": "searching"})

            # 并行运行 Agent 并从队列消费事件
            async def run():
                nonlocal disconnected
                try:
                    result = await run_agent(
                        messages=[] if is_resume else messages_for_agent,
                        thread_id=thread_id,
                        decision=web_search_decision if is_resume else None,
                        on_stage=on_stage,
                        on_token=on_token,
                    )
                    await queue.put(("__done__", result))
                except Exception as e:
                    await queue.put(("__error__", str(e)))

            agent_task = asyncio.create_task(run())

            # 消费队列事件
            try:
                while True:
                    try:
                        event_type, payload = await asyncio.wait_for(
                            queue.get(), timeout=0.1
                        )
                    except asyncio.TimeoutError:
                        if disconnected:
                            agent_task.cancel()
                            return
                        continue

                    if event_type == "__done__":
                        graph_result = payload

                        if graph_result.get("type") == "interrupt":
                            interrupt_data = graph_result["interrupt"]
                            yield _sse("action_required", {
                                "type": interrupt_data.get("type", "web_search_confirmation"),
                                "threadId": thread_id,
                                "message": interrupt_data.get("message", ""),
                                "question": interrupt_data.get("question", ""),
                                "reason": interrupt_data.get("reason", "low_confidence"),
                                "confidence": interrupt_data.get("confidence"),
                                "confirmLabel": interrupt_data.get("confirmLabel", "确定"),
                                "cancelLabel": interrupt_data.get("cancelLabel", "取消"),
                            })
                            return

                        # 完成
                        answer = graph_result.get("answer", "")
                        citations = graph_result.get("citations", [])

                        assistant_msg = {"role": "assistant", "content": answer}
                        await append_to_history(thread_id, assistant_msg)

                        yield _sse("done", {
                            "ok": True,
                            "threadId": thread_id,
                            "answer": answer,
                            "citations": citations,
                        })
                        return

                    elif event_type == "__error__":
                        raise Exception(payload)

                    else:
                        yield _sse(event_type, payload)

            finally:
                if not agent_task.done():
                    agent_task.cancel()
                    try:
                        await agent_task
                    except asyncio.CancelledError:
                        pass

        except asyncio.CancelledError:
            disconnected = True
        except Exception as e:
            if not disconnected:
                logger.error(f"Agent chat error: {e}")
                yield _sse("error", {"ok": False, "message": "处理请求时发生错误"})

    async def on_disconnect():
        nonlocal disconnected
        disconnected = True

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
        background=on_disconnect,
    )
