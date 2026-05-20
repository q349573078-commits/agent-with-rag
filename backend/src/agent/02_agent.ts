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
  signal?: AbortSignal
) {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim());

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

  const topK = env.RERANK_TOP_K;
  const candidateK = env.RERANK_ENABLED
    ? Math.max(env.RERANK_CANDIDATES, topK)
    : topK;

  const { docs: retrievedDocs, confidence } = await retrieveRelevantChunks(
    latestUserMessage.content,
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
    docs = env.RERANK_ENABLED
      ? await rerankDocsWithLLM({
          query: latestUserMessage.content,
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
    fallbackReason,
    question: latestUserMessage.content,
    shouldAskWebSearch: !!fallbackReason,
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
  citations: Annotation<AgentCitation[]>(),
  confidence: Annotation<number | null>(),
  docs: Annotation<SerializableDoc[]>(),
  fallbackReason: Annotation<RetrievalFallbackReason | null>(),
  messages: Annotation<{ role: string; content: string }[]>(),
  question: Annotation<string>(),
  shouldAskWebSearch: Annotation<boolean>(),
  webResults: Annotation<WebSearchResult[]>(),
  webSearchDecision: Annotation<WebSearchDecision | null>(),
  webSearchError: Annotation<string | null>(),
});

function createProductAgentGraph(args: {
  onToken?: (token: string) => void | Promise<void>;
  signal?: AbortSignal;
}) {
  const { onToken, signal } = args;

  return new StateGraph(ProductAgentState)
    .addNode("retrieve", async (state) => {
      assertNotAborted(signal);
      const plan = await buildRetrievalPlan(state.messages, signal);
      return {
        citations: plan.citations,
        confidence: plan.confidence,
        docs: plan.docs,
        fallbackReason: plan.fallbackReason,
        question: plan.question,
        shouldAskWebSearch: plan.shouldAskWebSearch,
        webResults: [],
        webSearchDecision: null,
        webSearchError: null,
      };
    })
    .addNode("ask_web_search_confirmation", (state) => {
      const reasonMessage =
        state.fallbackReason === "no_retrieval"
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
          citations: [],
        };
      }

      const answer =
        (await generateAnswerFromContext({
          answerInstruction: "请只基于这些知识库文档回答最后一个用户问题。",
          contextLabel: "知识库文档上下文",
          contextText: formatKbContext(state.docs),
          messages: state.messages,
          onToken,
          signal,
        })) || FALLBACK_ANSWER;

      return {
        answer,
        citations: state.citations,
      };
    })
    .addNode("search_web", async (state) => {
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
          citations: [],
        };
      }

      if (state.webResults.length === 0) {
        return {
          answer: WEB_SEARCH_EMPTY_ANSWER,
          citations: [],
        };
      }

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
        citations: state.citations,
      };
    })
    .addNode("cancel_web_search", () => {
      return {
        answer: WEB_SEARCH_CANCELLED_ANSWER,
        citations: [],
      };
    })
    .addEdge(START, "retrieve")
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
    .addEdge("answer_from_kb", END)
    .addEdge("search_web", "answer_from_web")
    .addEdge("answer_from_web", END)
    .addEdge("cancel_web_search", END)
    .compile({
      checkpointer: graphCheckpointer,
    });
}

export async function runProductAgentGraph(args: {
  messages?: { role: string; content: string }[];
  threadId: string;
  decision?: WebSearchDecision;
  onToken?: (token: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<AgentGraphResult> {
  const { decision, messages = [], onToken, signal, threadId } = args;
  const graph = createProductAgentGraph({ onToken, signal });
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
