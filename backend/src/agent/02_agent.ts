import { z } from "zod";
import {
  Annotation,
  Command,
  END,
  INTERRUPT,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { TavilySearch } from "@langchain/tavily";
import { chatModel, rerankModel } from "../utils/openai";
import { AGENT_SYSTEM_PROMPT } from "./01_policy";
import { retrieveRelevantChunks } from "../kb/05_retriever";
import { env } from "../utils/env";

type SerializableDoc = {
  pageContent: string;
  metadata?: Record<string, unknown>;
};

type WebSearchDecision = "confirm" | "cancel";
type RetrievalFallbackReason = "no_retrieval" | "low_confidence";
type AnswerSource = "kb" | "web" | "none";
type ReflectionAction = "accept" | "rewrite" | "ask_web_search";
type AgentStage =
  | "planning"
  | "retrieving"
  | "reranking"
  | "answering"
  | "web_searching"
  | "reflecting";

type QueryPlan = {
  intent: string;
  needsKbRetrieval: boolean;
  needsWebSearch: boolean;
  searchQuery: string;
  answerStyle: "concise" | "detailed" | "step_by_step";
  riskLevel: "low" | "medium" | "high";
};

type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
};

export interface AgentCitation {
  source: string;
  preview: string;
  url?: string;
  type?: "kb" | "web";
}

export interface PendingWebSearchInterrupt {
  type: "web_search_confirmation";
  message: string;
  question: string;
  reason: RetrievalFallbackReason;
  confidence: number | null;
  confirmLabel: string;
  cancelLabel: string;
}

type AgentGraphDoneResult = {
  type: "done";
  answer: string;
  citations: AgentCitation[];
};

type AgentGraphInterruptResult = {
  type: "interrupt";
  interrupt: PendingWebSearchInterrupt;
};

export type AgentGraphResult = AgentGraphDoneResult | AgentGraphInterruptResult;

const FALLBACK_ANSWER = "根据现有知识库文档，我暂时无法可靠回答这个问题。";
const WEB_SEARCH_CANCELLED_ANSWER = "已取消联网搜索。";
const WEB_SEARCH_EMPTY_ANSWER = "已尝试联网搜索，但没有检索到足够可靠的公开网页结果。";
const WEB_SEARCH_CONFIG_MISSING_ANSWER =
  "已确认联网搜索，但服务端尚未配置 `TAVILY_API_KEY`，暂时无法执行互联网检索。";

const graphCheckpointer = new MemorySaver();

const DEFAULT_QUERY_PLAN: QueryPlan = {
  intent: "answer_question",
  needsKbRetrieval: true,
  needsWebSearch: false,
  searchQuery: "",
  answerStyle: "concise",
  riskLevel: "low",
};

function buildKbCitations(docs: SerializableDoc[]): AgentCitation[] {
  const sourceMap = new Map<string, string>();

  for (const doc of docs) {
    const source = (doc?.metadata?.source as string) || "unknown_source";

    if (!sourceMap.has(source)) {
      const preview =
        doc.pageContent.length > 400
          ? doc.pageContent.slice(0, 400) + "..."
          : doc.pageContent;

      sourceMap.set(source, preview);
    }
  }

  return Array.from(sourceMap.entries()).map(([source, preview]) => ({
    source,
    preview,
    type: "kb",
  }));
}

function buildWebCitations(results: WebSearchResult[]): AgentCitation[] {
  return results.map((result) => ({
    source: result.title || result.url,
    preview:
      result.content.length > 400
        ? result.content.slice(0, 400) + "..."
        : result.content,
    url: result.url,
    type: "web",
  }));
}

function formatHistory(messages: { role: string; content: string }[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "助手" : "用户";
      return `${role}: ${message.content}`;
    })
    .join("\n");
}

function formatKbContext(docs: SerializableDoc[]): string {
  return docs
    .map((doc, index) => {
      const source = (doc?.metadata?.source as string) || "unknown_source";
      return `资料${index + 1}（${source}）\n${doc.pageContent}`;
    })
    .join("\n\n");
}

function formatWebContext(results: WebSearchResult[]): string {
  return results
    .map((result, index) => {
      return [
        `网页${index + 1}`,
        `标题：${result.title || "未命名来源"}`,
        `链接：${result.url}`,
        `相关度：${result.score.toFixed(3)}`,
        result.content,
      ].join("\n");
    })
    .join("\n\n");
}

function extractChunkText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("");
}

function truncateForRerank(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars) + "...";
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("AbortError");
  }
}

const RerankResponseSchema = z.object({
  order: z.array(z.number().int().nonnegative()).default([]),
});

const QueryPlanSchema = z.object({
  intent: z.string().trim().min(1).default(DEFAULT_QUERY_PLAN.intent),
  needsKbRetrieval: z.boolean().default(DEFAULT_QUERY_PLAN.needsKbRetrieval),
  needsWebSearch: z.boolean().default(DEFAULT_QUERY_PLAN.needsWebSearch),
  searchQuery: z.string().trim().default(""),
  answerStyle: z
    .enum(["concise", "detailed", "step_by_step"])
    .default(DEFAULT_QUERY_PLAN.answerStyle),
  riskLevel: z.enum(["low", "medium", "high"]).default(DEFAULT_QUERY_PLAN.riskLevel),
});

const ReflectionResponseSchema = z.object({
  action: z.enum(["accept", "rewrite", "ask_web_search"]).default("accept"),
  answer: z.string().trim().optional(),
  reason: z.string().trim().optional(),
});

function getLatestUserMessage(messages: { role: string; content: string }[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim());
}

async function buildQueryPlan(args: {
  messages: { role: string; content: string }[];
  signal?: AbortSignal;
}): Promise<QueryPlan> {
  const { messages, signal } = args;
  const latestUserMessage = getLatestUserMessage(messages);

  if (!latestUserMessage) {
    return DEFAULT_QUERY_PLAN;
  }

  const fallbackPlan: QueryPlan = {
    ...DEFAULT_QUERY_PLAN,
    searchQuery: latestUserMessage.content.trim(),
  };

  const prompt = [
    {
      role: "system" as const,
      content:
        "你是 RAG 问答系统的计划器。根据对话历史生成执行计划，只返回 JSON，不要回答用户问题。",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task:
            "判断这个问题应该如何检索和回答。searchQuery 必须是适合向量检索的完整独立问题；如果最后一句依赖上下文，请结合历史改写。needsWebSearch 表示该问题可能需要知识库外的最新、公开或实时信息，但仍需用户确认后才能联网。",
          outputShape: {
            intent: "string",
            needsKbRetrieval: "boolean",
            needsWebSearch: "boolean",
            searchQuery: "string",
            answerStyle: "concise | detailed | step_by_step",
            riskLevel: "low | medium | high",
          },
          conversation: messages,
        },
        null,
        2
      ),
    },
  ];

  try {
    const result = await rerankModel.invoke(prompt, {
      signal,
      response_format: { type: "json_object" },
    });
    const text = extractChunkText(result.content);
    const parsedJson = JSON.parse(text);
    const parsed = QueryPlanSchema.safeParse(parsedJson);

    if (!parsed.success) {
      console.error("Query plan Zod parse error:", parsed.error);
      return fallbackPlan;
    }

    return {
      ...parsed.data,
      searchQuery: parsed.data.searchQuery || latestUserMessage.content.trim(),
    };
  } catch (err) {
    console.error("Query plan failed:", err);
    return fallbackPlan;
  }
}

async function rerankDocsWithLLM(args: {
  query: string;
  docs: SerializableDoc[];
  topK: number;
  signal?: AbortSignal;
}): Promise<SerializableDoc[]> {
  const { query, docs, topK, signal } = args;

  if (docs.length <= 1) {
    return docs.slice(0, topK);
  }

  const candidates = docs.map((doc, index) => {
    return {
      id: index,
      text: truncateForRerank(doc.pageContent, 900),
    };
  });

  const prompt = [
    {
      role: "system" as const,
      content:
        "你是一个 rerank 模型。给定用户问题与候选段落，选择最有助于回答该问题的段落，并按相关性从高到低排序。必须返回 JSON 格式，包含一个 `order` 字段，其值为候选段落的 id 数组。",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          query,
          topK,
          candidates,
        },
        null,
        2
      ),
    },
  ];

  try {
    const result = await rerankModel.invoke(prompt, {
      signal,
      response_format: { type: "json_object" },
    });
    const text = extractChunkText(result.content);
    const parsedJson = JSON.parse(text);
    const parsed = RerankResponseSchema.safeParse(parsedJson);

    if (!parsed.success) {
      console.error("Rerank Zod parse error:", parsed.error);
      return docs.slice(0, topK);
    }

    const seen = new Set<number>();
    const picked: SerializableDoc[] = [];

    for (const id of parsed.data.order) {
      if (picked.length >= topK) break;
      if (id < 0 || id >= docs.length) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      picked.push(docs[id]);
    }

    for (let i = 0; i < docs.length && picked.length < topK; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      picked.push(docs[i]);
    }

    return picked;
  } catch (err) {
    console.error("Rerank failed:", err);
    return docs.slice(0, topK);
  }
}

async function buildRetrievalPlan(
  messages: { role: string; content: string }[],
  queryPlan: QueryPlan,
  onStage?: (stage: AgentStage) => void | Promise<void>,
  signal?: AbortSignal
) {
  const latestUserMessage = getLatestUserMessage(messages);

  if (!latestUserMessage) {
    return {
      citations: [] as AgentCitation[],
      confidence: null as number | null,
      docs: [] as SerializableDoc[],
      fallbackReason: "no_retrieval" as RetrievalFallbackReason,
      question: "",
      shouldAskWebSearch: false,
    };
  }

  const question = latestUserMessage.content.trim();
  const searchQuery = queryPlan.searchQuery.trim() || question;

  if (!queryPlan.needsKbRetrieval) {
    return {
      citations: [] as AgentCitation[],
      confidence: 0,
      docs: [] as SerializableDoc[],
      fallbackReason: "no_retrieval" as RetrievalFallbackReason,
      question,
      shouldAskWebSearch: queryPlan.needsWebSearch,
    };
  }

  const topK = env.RERANK_TOP_K;
  const candidateK = env.RERANK_ENABLED
    ? Math.max(env.RERANK_CANDIDATES, topK)
    : topK;

  const { docs: retrievedDocs, confidence } = await retrieveRelevantChunks(
    searchQuery,
    candidateK
  );

  const fallbackReason: RetrievalFallbackReason | null =
    retrievedDocs.length === 0
      ? "no_retrieval"
      : confidence < env.RETRIEVAL_LOW_CONFIDENCE_THRESHOLD
        ? "low_confidence"
        : null;

  let docs: SerializableDoc[] = [];
  if (!fallbackReason) {
    if (env.RERANK_ENABLED) {
      await onStage?.("reranking");
    }

    docs = env.RERANK_ENABLED
      ? await rerankDocsWithLLM({
          query: searchQuery,
          docs: retrievedDocs.map((doc) => ({
            pageContent: doc.pageContent,
            metadata: doc.metadata,
          })),
          topK,
          signal,
        })
      : retrievedDocs.slice(0, topK).map((doc) => ({
          pageContent: doc.pageContent,
          metadata: doc.metadata,
        }));
  }

  return {
    citations: buildKbCitations(docs),
    confidence,
    docs,
    fallbackReason: queryPlan.needsWebSearch
      ? ("low_confidence" as RetrievalFallbackReason)
      : fallbackReason,
    question,
    shouldAskWebSearch: queryPlan.needsWebSearch || !!fallbackReason,
  };
}

async function generateAnswerFromContext(args: {
  messages: { role: string; content: string }[];
  contextLabel: string;
  contextText: string;
  answerInstruction: string;
  onToken?: (token: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<string> {
  const {
    messages,
    contextLabel,
    contextText,
    answerInstruction,
    onToken,
    signal,
  } = args;

  const prompt = [
    {
      role: "system",
      content: AGENT_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        "以下是对话历史：",
        formatHistory(messages),
        "",
        `以下是可用${contextLabel}：`,
        contextText,
        "",
        answerInstruction,
      ].join("\n"),
    },
  ];

  const stream = await chatModel.stream(prompt, { signal });
  let answer = "";

  for await (const chunk of stream) {
    assertNotAborted(signal);
    const token = extractChunkText(chunk.content);

    if (!token) {
      continue;
    }

    answer += token;
    await onToken?.(token);
  }

  return answer.trim();
}

async function reflectAnswer(args: {
  answer: string;
  answerSource: AnswerSource;
  docs: SerializableDoc[];
  messages: { role: string; content: string }[];
  queryPlan: QueryPlan;
  webResults: WebSearchResult[];
  signal?: AbortSignal;
}): Promise<{
  action: ReflectionAction;
  answer?: string;
  reason?: string;
}> {
  const { answer, answerSource, docs, messages, queryPlan, webResults, signal } =
    args;

  if (
    !answer.trim() ||
    answer === FALLBACK_ANSWER ||
    answer === WEB_SEARCH_CANCELLED_ANSWER ||
    answer === WEB_SEARCH_EMPTY_ANSWER ||
    answer === WEB_SEARCH_CONFIG_MISSING_ANSWER
  ) {
    return {
      action: "accept",
    };
  }

  const contextText =
    answerSource === "web" ? formatWebContext(webResults) : formatKbContext(docs);

  if (!contextText.trim()) {
    return {
      action: "rewrite",
      answer:
        answerSource === "web" ? WEB_SEARCH_EMPTY_ANSWER : FALLBACK_ANSWER,
      reason: "No supporting context was available.",
    };
  }

  const prompt = [
    {
      role: "system" as const,
      content:
        "你是 RAG 答案审查器。检查答案是否严格由给定上下文支持，并只返回 JSON。",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task:
            "判断 assistantAnswer 是否回答了 latestUserQuestion，且是否完全受到 suppliedContext 支持。若答案包含上下文外断言或答非所问，返回 rewrite 并给出更保守的 answer。若知识库答案明显需要知识库外信息才能可靠回答，可返回 ask_web_search。不要添加上下文没有的信息。",
          allowedActions:
            answerSource === "kb"
              ? ["accept", "rewrite", "ask_web_search"]
              : ["accept", "rewrite"],
          outputShape: {
            action: "accept | rewrite | ask_web_search",
            answer: "string, required only when action is rewrite",
            reason: "string",
          },
          answerSource,
          queryPlan,
          conversation: messages,
          latestUserQuestion: getLatestUserMessage(messages)?.content ?? "",
          suppliedContext: contextText,
          assistantAnswer: answer,
        },
        null,
        2
      ),
    },
  ];

  try {
    const result = await rerankModel.invoke(prompt, {
      signal,
      response_format: { type: "json_object" },
    });
    const text = extractChunkText(result.content);
    const parsedJson = JSON.parse(text);
    const parsed = ReflectionResponseSchema.safeParse(parsedJson);

    if (!parsed.success) {
      console.error("Reflection Zod parse error:", parsed.error);
      return {
        action: "accept",
      };
    }

    const action =
      answerSource === "web" && parsed.data.action === "ask_web_search"
        ? "rewrite"
        : parsed.data.action;

    if (action === "rewrite" && !parsed.data.answer) {
      return {
        action: "rewrite",
        answer: answerSource === "web" ? WEB_SEARCH_EMPTY_ANSWER : FALLBACK_ANSWER,
        reason: parsed.data.reason,
      };
    }

    return {
      action,
      answer: parsed.data.answer,
      reason: parsed.data.reason,
    };
  } catch (err) {
    console.error("Reflection failed:", err);
    return {
      action: "accept",
    };
  }
}

async function searchWeb(question: string, signal?: AbortSignal) {
  assertNotAborted(signal);

  if (!env.TAVILY_API_KEY) {
    return {
      citations: [] as AgentCitation[],
      errorMessage: WEB_SEARCH_CONFIG_MISSING_ANSWER,
      results: [] as WebSearchResult[],
    };
  }

  const tool = new TavilySearch({
    maxResults: 5,
    includeAnswer: false,
    includeRawContent: "markdown",
    searchDepth: "advanced",
    tavilyApiKey: env.TAVILY_API_KEY,
    topic: "general",
  });

  const response = await tool.invoke({
    query: question,
    topic: "general",
    searchDepth: "advanced",
  });

  assertNotAborted(signal);

  if ("error" in response) {
    console.error("Tavily search failed:", response.error);
    return {
      citations: [] as AgentCitation[],
      errorMessage: "联网搜索失败，请稍后重试。",
      results: [] as WebSearchResult[],
    };
  }

  const results = response.results.map((result: {
    title: string;
    url: string;
    content: string;
    raw_content: string | null;
    score: number;
  }) => ({
    title: result.title,
    url: result.url,
    content: result.raw_content || result.content || "",
    score: result.score,
  }));

  return {
    citations: buildWebCitations(results),
    errorMessage: null as string | null,
    results,
  };
}

const ProductAgentState = Annotation.Root({
  answer: Annotation<string>(),
  answerSource: Annotation<AnswerSource>(),
  citations: Annotation<AgentCitation[]>(),
  confidence: Annotation<number | null>(),
  docs: Annotation<SerializableDoc[]>(),
  fallbackReason: Annotation<RetrievalFallbackReason | null>(),
  messages: Annotation<{ role: string; content: string }[]>(),
  question: Annotation<string>(),
  queryPlan: Annotation<QueryPlan>(),
  reflectionAction: Annotation<ReflectionAction>(),
  shouldAskWebSearch: Annotation<boolean>(),
  webResults: Annotation<WebSearchResult[]>(),
  webSearchDecision: Annotation<WebSearchDecision | null>(),
  webSearchError: Annotation<string | null>(),
});

function createProductAgentGraph(args: {
  onStage?: (stage: AgentStage) => void | Promise<void>;
  onToken?: (token: string) => void | Promise<void>;
  signal?: AbortSignal;
}) {
  const { onStage, onToken, signal } = args;

  return new StateGraph(ProductAgentState)
    .addNode("plan_query", async (state) => {
      assertNotAborted(signal);
      await onStage?.("planning");
      const queryPlan = await buildQueryPlan({
        messages: state.messages,
        signal,
      });

      return {
        queryPlan,
      };
    })
    .addNode("retrieve", async (state) => {
      assertNotAborted(signal);
      await onStage?.("retrieving");
      const plan = await buildRetrievalPlan(
        state.messages,
        state.queryPlan || DEFAULT_QUERY_PLAN,
        onStage,
        signal
      );
      return {
        answerSource: "none" as AnswerSource,
        citations: plan.citations,
        confidence: plan.confidence,
        docs: plan.docs,
        fallbackReason: plan.fallbackReason,
        question: plan.question,
        reflectionAction: "accept" as ReflectionAction,
        shouldAskWebSearch: plan.shouldAskWebSearch,
        webResults: [],
        webSearchDecision: null,
        webSearchError: null,
      };
    })
    .addNode("ask_web_search_confirmation", (state) => {
      const reasonMessage =
        state.queryPlan?.needsWebSearch
          ? "这个问题可能需要知识库之外的最新或公开信息。"
          : state.fallbackReason === "no_retrieval"
          ? "知识库中没有检索到可用于回答当前问题的内容。"
          : "知识库检索到了内容，但当前结果置信度偏低。";

      const decision = interrupt<
        PendingWebSearchInterrupt,
        { action: WebSearchDecision }
      >({
        type: "web_search_confirmation",
        message: `${reasonMessage} 是否需要改为联网搜索后再生成答案？`,
        question: state.question,
        reason: state.fallbackReason || "low_confidence",
        confidence: state.confidence ?? null,
        confirmLabel: "确定",
        cancelLabel: "取消",
      });

      return {
        webSearchDecision: decision.action,
      };
    })
    .addNode("answer_from_kb", async (state) => {
      if (!state.question || state.docs.length === 0) {
        return {
          answer: FALLBACK_ANSWER,
          answerSource: "none" as AnswerSource,
          citations: [],
        };
      }

      await onStage?.("answering");
      const answer =
        (await generateAnswerFromContext({
          answerInstruction: [
            "请只基于这些知识库文档回答最后一个用户问题。",
            `回答风格：${state.queryPlan?.answerStyle ?? "concise"}。`,
            `风险等级：${state.queryPlan?.riskLevel ?? "low"}；风险越高，越要保守，不确定时直接说明当前上下文不足。`,
          ].join("\n"),
          contextLabel: "知识库文档上下文",
          contextText: formatKbContext(state.docs),
          messages: state.messages,
          onToken,
          signal,
        })) || FALLBACK_ANSWER;

      return {
        answer,
        answerSource: "kb" as AnswerSource,
        citations: state.citations,
      };
    })
    .addNode("search_web", async (state) => {
      await onStage?.("web_searching");
      const result = await searchWeb(state.question, signal);
      return {
        citations: result.citations,
        webResults: result.results,
        webSearchError: result.errorMessage,
      };
    })
    .addNode("answer_from_web", async (state) => {
      if (state.webSearchError) {
        return {
          answer: state.webSearchError,
          answerSource: "none" as AnswerSource,
          citations: [],
        };
      }

      if (state.webResults.length === 0) {
        return {
          answer: WEB_SEARCH_EMPTY_ANSWER,
          answerSource: "none" as AnswerSource,
          citations: [],
        };
      }

      await onStage?.("answering");
      const answer =
        (await generateAnswerFromContext({
          answerInstruction:
            "请优先基于这些联网搜索结果回答最后一个用户问题；如果来源之间存在冲突，请明确说明。",
          contextLabel: "联网搜索结果",
          contextText: formatWebContext(state.webResults),
          messages: state.messages,
          onToken,
          signal,
        })) || WEB_SEARCH_EMPTY_ANSWER;

      return {
        answer,
        answerSource: "web" as AnswerSource,
        citations: state.citations,
      };
    })
    .addNode("reflect_answer", async (state) => {
      assertNotAborted(signal);
      await onStage?.("reflecting");
      const reflection = await reflectAnswer({
        answer: state.answer,
        answerSource: state.answerSource || "none",
        docs: state.docs,
        messages: state.messages,
        queryPlan: state.queryPlan || DEFAULT_QUERY_PLAN,
        webResults: state.webResults,
        signal,
      });

      if (reflection.action === "ask_web_search") {
        return {
          fallbackReason: "low_confidence" as RetrievalFallbackReason,
          reflectionAction: reflection.action,
          shouldAskWebSearch: true,
        };
      }

      if (reflection.action === "rewrite") {
        return {
          answer:
            reflection.answer ||
            (state.answerSource === "web" ? WEB_SEARCH_EMPTY_ANSWER : FALLBACK_ANSWER),
          citations: [],
          reflectionAction: reflection.action,
          shouldAskWebSearch: false,
        };
      }

      return {
        reflectionAction: reflection.action,
      };
    })
    .addNode("cancel_web_search", () => {
      return {
        answer: WEB_SEARCH_CANCELLED_ANSWER,
        answerSource: "none" as AnswerSource,
        citations: [],
      };
    })
    .addEdge(START, "plan_query")
    .addEdge("plan_query", "retrieve")
    .addConditionalEdges("retrieve", (state) => {
      return state.shouldAskWebSearch
        ? "ask_web_search_confirmation"
        : "answer_from_kb";
    })
    .addConditionalEdges("ask_web_search_confirmation", (state) => {
      return state.webSearchDecision === "confirm"
        ? "search_web"
        : "cancel_web_search";
    })
    .addEdge("answer_from_kb", "reflect_answer")
    .addConditionalEdges("reflect_answer", (state) => {
      return state.reflectionAction === "ask_web_search"
        ? "ask_web_search_confirmation"
        : END;
    })
    .addEdge("search_web", "answer_from_web")
    .addEdge("answer_from_web", "reflect_answer")
    .addEdge("cancel_web_search", END)
    .compile({
      checkpointer: graphCheckpointer,
    });
}

export async function runProductAgentGraph(args: {
  messages?: { role: string; content: string }[];
  threadId: string;
  decision?: WebSearchDecision;
  onStage?: (stage: AgentStage) => void | Promise<void>;
  onToken?: (token: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<AgentGraphResult> {
  const { decision, messages = [], onStage, onToken, signal, threadId } = args;
  const graph = createProductAgentGraph({ onStage, onToken, signal });
  const config = {
    configurable: {
      thread_id: threadId,
    },
  };
  const result = decision
    ? await graph.invoke(
        new Command({
          resume: { action: decision },
        }) as any,
        config
      )
    : await graph.invoke(
        {
          messages,
        },
        config
      );

  if (graph.isInterrupted(result)) {
    const pending = result[INTERRUPT][0]?.value as
      | PendingWebSearchInterrupt
      | undefined;

    if (!pending) {
      throw new Error("Missing interrupt payload");
    }

    return {
      type: "interrupt",
      interrupt: pending,
    };
  }

  return {
    type: "done",
    answer: result.answer?.trim() || FALLBACK_ANSWER,
    citations: Array.isArray(result.citations) ? result.citations : [],
  };
}
