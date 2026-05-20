import { Document } from "@langchain/core/documents";
import { z } from "zod";
import { chatModel, rerankModel } from "../utils/openai";
import { AGENT_SYSTEM_PROMPT } from "./01_policy";
import { retrieveRelevantChunks } from "../kb/05_retriever";
import { env } from "../utils/env";

export interface AgentCitation {
  source: string;
  preview: string;
}

function buildCitations(
  docs: { pageContent: string; metadata?: Record<string, unknown> }[]
): AgentCitation[] {
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

function formatContext(
  docs: { pageContent: string; metadata?: Record<string, unknown> }[]
): string {
  return docs
    .map((doc, index) => {
      const source = (doc?.metadata?.source as string) || "unknown_source";
      return `资料${index + 1}（${source}）\n${doc.pageContent}`;
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

const RerankResponseSchema = z.object({
  order: z.array(z.number().int().nonnegative()).default([]),
});

async function rerankDocsWithLLM(args: {
  query: string;
  docs: Document[];
  topK: number;
  signal?: AbortSignal;
}): Promise<Document[]> {
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
    const picked: Document[] = [];

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

async function buildAnswerPlan(
  messages: { role: string; content: string }[],
  signal?: AbortSignal
) {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim());

  if (!latestUserMessage) {
    return {
      citations: [] as AgentCitation[],
      docs: [],
      shouldFallback: true,
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

  const shouldFallback = retrievedDocs.length === 0 || confidence < 0.2;

  let docs: Document[] = [];
  if (!shouldFallback) {
    docs = env.RERANK_ENABLED
      ? await rerankDocsWithLLM({
          query: latestUserMessage.content,
          docs: retrievedDocs,
          topK,
          signal,
        })
      : retrievedDocs.slice(0, topK);
  }

  const citations = buildCitations(docs);

  return {
    citations,
    docs,
    shouldFallback,
  };
}

export async function streamProductAgent(
  messages: { role: string; content: string }[],
  onToken?: (token: string) => void | Promise<void>,
  signal?: AbortSignal
): Promise<{ answer: string; citations: AgentCitation[] }> {
  const assertNotAborted = () => {
    if (signal?.aborted) {
      throw new Error("AbortError");
    }
  };

  assertNotAborted();
  const { citations, docs, shouldFallback } = await buildAnswerPlan(
    messages,
    signal
  );
  const fallback = "根据现有文档，我无法回答。";

  if (shouldFallback) {
    for (const token of fallback) {
      assertNotAborted();
      await onToken?.(token);
    }

    return {
      answer: fallback,
      citations: [],
    };
  }

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
        "以下是可用文档上下文：",
        formatContext(docs),
        "",
        "请只基于这些文档上下文回答最后一个用户问题。",
      ].join("\n"),
    },
  ];

  const stream = await chatModel.stream(prompt, { signal });
  let answer = "";

  for await (const chunk of stream) {
    assertNotAborted();
    const token = extractChunkText(chunk.content);

    if (!token) {
      continue;
    }

    answer += token;
    await onToken?.(token);
  }

  const finalAnswer = answer.trim() || fallback;

  return {
    answer: finalAnswer,
    citations: finalAnswer === fallback ? [] : citations,
  };
}

export async function runProductAgent(
  messages: { role: string; content: string }[]
): Promise<{ answer: string; citations: AgentCitation[] }> {
  return streamProductAgent(messages);
}
