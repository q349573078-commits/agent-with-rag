import { chatModel } from "../utils/openai";
import { AGENT_SYSTEM_PROMPT } from "./01_policy";
import { retrieveRelevantChunks } from "../kb/05_retriever";

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

async function buildAnswerPlan(messages: { role: string; content: string }[]) {
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

  const { docs, confidence } = await retrieveRelevantChunks(
    latestUserMessage.content,
    4
  );
  const citations = buildCitations(docs);
  const shouldFallback = docs.length === 0 || confidence < 0.2;

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
  const { citations, docs, shouldFallback } = await buildAnswerPlan(messages);
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
