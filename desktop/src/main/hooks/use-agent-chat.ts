import { useCallback, useState, useRef } from "react";
import type { ChatBubble, Citation, PendingWebSearchAction } from "@shared/types/chat";
import { parseSseBlock } from "@shared/lib/sse";
import { getApiBaseUrl } from "@shared/config";
import { createMessageId } from "@shared/lib/helpers";

export function useAgentChat() {
  const [input, setInput] = useState("");
  const [thread, setThread] = useState<ChatBubble[]>([]);
  const [loading, setLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const BASE = getApiBaseUrl();

  const streamAgentResponse = useCallback(
    async (
      body: {
        threadId?: string | null;
        message?: string;
        webSearchDecision?: "confirm" | "cancel";
      },
      assistantMsgId: string
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;

      const updateAssistantMessage = (
        updater: (message: ChatBubble) => ChatBubble
      ) => {
        setThread((currentThread) =>
          currentThread.map((message) =>
            message.id === assistantMsgId ? updater(message) : message
          )
        );
      };

      const res = await fetch(`${BASE}/agent/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error("Something went wrong");
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("Streaming response is not available");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();

        buffer += decoder.decode(value, { stream: !done });

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;

          if (parsed.event === "thread") {
            if (parsed.data.threadId) {
              setThreadId(parsed.data.threadId);
            }
            continue;
          }

          if (parsed.event === "chunk") {
            updateAssistantMessage((message) => ({
              ...message,
              content: message.content + parsed.data.content,
            }));
            continue;
          }

          if (parsed.event === "action_required") {
            if (parsed.data.threadId) {
              setThreadId(parsed.data.threadId);
            }
            updateAssistantMessage((message) => ({
              ...message,
              content: parsed.data.message,
              citations: [],
              pendingAction: {
                cancelLabel: parsed.data.cancelLabel,
                confidence: parsed.data.confidence,
                confirmLabel: parsed.data.confirmLabel,
                message: parsed.data.message,
                question: parsed.data.question,
                reason: parsed.data.reason,
                status: "idle",
                type: parsed.data.type,
              },
            }));
            continue;
          }

          if (parsed.event === "done") {
            if (parsed.data.threadId) {
              setThreadId(parsed.data.threadId);
            }
            updateAssistantMessage((message) => ({
              ...message,
              content: parsed.data.answer || message.content,
              citations: parsed.data.citations || [],
              pendingAction: null,
            }));
            continue;
          }

          if (parsed.event === "error") {
            throw new Error(parsed.data.message || "Something went wrong");
          }
        }

        if (done) break;
      }
    },
    [BASE]
  );

  const onRun = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userContent = input.trim();
    const userMsg: ChatBubble = {
      id: createMessageId(),
      role: "user",
      content: userContent,
    };
    const assistantMsg: ChatBubble = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      citations: [],
      pendingAction: null,
    };

    setThread((t) => [...t, userMsg, assistantMsg]);
    setInput("");
    setLoading(true);

    try {
      await streamAgentResponse(
        { threadId, message: userContent },
        assistantMsg.id
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      console.error(e);
      setThread((currentThread) =>
        currentThread.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content: m.content || "Something went wrong",
                pendingAction: null,
              }
            : m
        )
      );
    } finally {
      setLoading(false);
    }
  }, [input, loading, threadId, streamAgentResponse]);

  const resumePendingWebSearch = useCallback(
    async (assistantMessageId: string, decision: "confirm" | "cancel") => {
      if (loading || !threadId) return;

      const updateAssistantMessage = (
        updater: (message: ChatBubble) => ChatBubble
      ) => {
        setThread((currentThread) =>
          currentThread.map((message) =>
            message.id === assistantMessageId ? updater(message) : message
          )
        );
      };

      updateAssistantMessage((message) => ({
        ...message,
        content: "",
        citations: [],
        pendingAction: message.pendingAction
          ? {
              ...message.pendingAction,
              status: decision === "confirm" ? "searching" : "cancelling",
            }
          : null,
      }));

      setLoading(true);

      try {
        await streamAgentResponse(
          { threadId, webSearchDecision: decision },
          assistantMessageId
        );
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return;
        console.error(e);
        updateAssistantMessage((message) => ({
          ...message,
          content: "Something went wrong",
          pendingAction: null,
        }));
      } finally {
        setLoading(false);
      }
    },
    [loading, threadId, streamAgentResponse]
  );

  return {
    input,
    setInput,
    thread,
    loading,
    threadId,
    onRun,
    resumePendingWebSearch,
  };
}
