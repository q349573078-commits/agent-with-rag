"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2,
  Info,
  Loader2,
  Send,
  Trash2,
  UploadIcon,
  XCircle,
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useState } from "react";
import { useTypewriter } from "@/hooks/use-typewriter";

type Citation = {
  source: string;
  preview: string;
  url?: string;
  type?: "kb" | "web";
};

type PendingWebSearchAction = {
  type: "web_search_confirmation";
  message: string;
  question: string;
  reason: "no_retrieval" | "low_confidence";
  confidence: number | null;
  confirmLabel: string;
  cancelLabel: string;
  status?: "idle" | "searching" | "cancelling";
};

type StreamDoneEvent = {
  ok: boolean;
  threadId: string;
  answer: string;
  citations: Citation[];
};

type StreamEvent =
  | {
    event: "thread";
    data: {
      threadId: string;
    };
  }
  | {
    event: "status";
    data: {
      stage: string;
    };
  }
  | {
    event: "chunk";
    data: {
      content: string;
    };
  }
  | {
    event: "done";
    data: StreamDoneEvent;
  }
  | {
    event: "action_required";
    data: PendingWebSearchAction & {
      threadId: string;
    };
  }
  | {
    event: "error";
    data: {
      message: string;
    };
  };

type ChatBubble = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  pendingAction?: PendingWebSearchAction | null;
};

type KbFileListItem = {
  id?: string | null;
  name: string;
  uploadedAt?: string | null;
  chunkCount?: number | null;
  sha256?: string | null;
  legacy?: boolean;
};

type UploadStatus = "idle" | "uploading" | "success" | "error" | "skipped";

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseSseBlock(block: string): StreamEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (!event || dataLines.length === 0) {
    return null;
  }

  try {
    return {
      event,
      data: JSON.parse(dataLines.join("\n")),
    } as StreamEvent;
  } catch {
    return null;
  }
}

export default function Home() {
  // chat state
  const [input, setInput] = useState("");
  const [thread, setThread] = useState<ChatBubble[]>([]);
  const [loading, setLoading] = useState(false);

  // threadid
  const [threadId, setThreadId] = useState<string | null>(null);

  // KB upload UI/panel
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [ingestRes, setIngestRes] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [kbUploading, setKbUploading] = useState(false);
  const [kbFilesLoading, setKbFilesLoading] = useState(false);
  const [kbFilesError, setKbFilesError] = useState<string | null>(null);
  const [kbDeleteError, setKbDeleteError] = useState<string | null>(null);
  const [kbDeletingKey, setKbDeletingKey] = useState<string | null>(null);
  const [kbFiles, setKbFiles] = useState<KbFileListItem[]>([]);
  const [kbHealthError, setKbHealthError] = useState<string | null>(null);

  const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5000";

  const checkKbHealth = useCallback(async () => {
    setKbHealthError(null);
    try {
      const res = await fetch(`${BASE}/kb/health`, { method: "GET" });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setKbHealthError(json?.message || "KB backend is unavailable");
        return false;
      }
      return true;
    } catch {
      setKbHealthError("KB backend is unavailable");
      return false;
    }
  }, [BASE]);

  const fetchKbFiles = useCallback(async () => {
    setKbFilesLoading(true);
    setKbFilesError(null);
    try {
      const res = await fetch(`${BASE}/kb/files`, { method: "GET" });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setKbFilesError(json?.message || "Failed to load KB files");
        setKbFiles([]);
        return;
      }

      const files = Array.isArray(json.files) ? json.files : [];
      setKbFiles(
        files
          .map((f: any) => ({
            id: typeof f?.id === "string" || f?.id === null ? f.id : null,
            name: typeof f?.name === "string" ? f.name : "unknown",
            uploadedAt:
              typeof f?.uploadedAt === "string" || f?.uploadedAt === null
                ? f.uploadedAt
                : null,
            chunkCount: typeof f?.chunkCount === "number" ? f.chunkCount : null,
            sha256: typeof f?.sha256 === "string" || f?.sha256 === null ? f.sha256 : null,
            legacy: !!f?.legacy,
          }))
          .filter((f: KbFileListItem) => f.name.trim().length > 0)
      );
    } catch {
      setKbFilesError("Failed to load KB files");
      setKbFiles([]);
    } finally {
      setKbFilesLoading(false);
    }
  }, [BASE]);

  const deleteKbFile = useCallback(
    async (file: KbFileListItem) => {
      setKbDeleteError(null);
      const deletingKey = file.id || `${file.name}::${file.sha256 ?? ""}::legacy`;
      setKbDeletingKey(deletingKey);
      try {
        const url = file.id
          ? `${BASE}/kb/files/${encodeURIComponent(file.id)}`
          : `${BASE}/kb/files?name=${encodeURIComponent(file.name)}`;
        const res = await fetch(url, { method: "DELETE" });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
          setKbDeleteError(json?.message || "Failed to delete KB file");
          return;
        }
        fetchKbFiles();
      } catch {
        setKbDeleteError("Failed to delete KB file");
      } finally {
        setKbDeletingKey(null);
      }
    },
    [BASE, fetchKbFiles]
  );

  const checkAlreadyUploaded = useCallback(async (file: File): Promise<{
    exists: boolean;
    matchBy: "hash" | "name";
  }> => {
    try {
      const hash = await sha256Hex(file);
      const res = await fetch(
        `${BASE}/kb/files/exists?hash=${encodeURIComponent(hash)}`
      );
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.message || "KB backend is unavailable");
      }
      return { exists: !!json?.exists, matchBy: "hash" };
    } catch {
      const res = await fetch(
        `${BASE}/kb/files/exists?name=${encodeURIComponent(file.name)}`
      );
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.message || "KB backend is unavailable");
      }
      return { exists: !!json?.exists, matchBy: "name" };
    }
  }, [BASE]);

  useEffect(() => {
    if (!showUploadPanel) return;
    (async () => {
      const ok = await checkKbHealth();
      if (ok) {
        fetchKbFiles();
      }
    })();
  }, [showUploadPanel, fetchKbFiles, checkKbHealth]);

  async function uploadFile(file: File) {
    setUploadStatus("uploading");
    setUploadMsg("Uploading...");
    try {
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch(`${BASE}/kb/upload`, {
        method: "POST",
        body: fd,
      });

      const json = await res.json().catch(() => null);
      setIngestRes(json ? JSON.stringify(json, null, 2) : null);

      if (res.ok && json?.ok) {
        if (json?.skipped) {
          setUploadStatus("skipped");
          setUploadMsg("Already uploaded. Skipped.");
        } else {
          setUploadStatus("success");
          setUploadMsg("Uploaded and ingested into KB");
        }
        fetchKbFiles();
      } else {
        setUploadStatus("error");
        setUploadMsg(
          (typeof json?.message === "string" && json.message.trim().length > 0
            ? json.message
            : typeof json?.errorMessage === "string" &&
                json.errorMessage.trim().length > 0
              ? json.errorMessage
              : null) || `Upload failed (HTTP ${res.status})`
        );
      }
    } catch (e) {
      setUploadStatus("error");
      setUploadMsg(e instanceof Error ? e.message : "Upload Failed...");
    }
  }

  async function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    const inputEl = e.currentTarget;
    const file = e.target.files?.[0];
    if (!file) {
      inputEl.value = "";
      return;
    }

    setKbUploading(true);
    try {
      setSelectedFile(file.name);
      setUploadMsg(null);
      setUploadStatus("uploading");
      setIngestRes(null);
      try {
        const check = await checkAlreadyUploaded(file);
        if (check.exists) {
          setUploadStatus("skipped");
          setUploadMsg(
            check.matchBy === "hash"
              ? "Already uploaded (content match). Skipped."
              : "Already uploaded (name match). Skipped."
          );
          fetchKbFiles();
        } else {
          await uploadFile(file);
        }
      } catch (err) {
        setUploadStatus("error");
        setUploadMsg(
          err instanceof Error
            ? err.message || "KB backend is unavailable. Upload skipped."
            : "KB backend is unavailable. Upload skipped."
        );
      }
    } finally {
      setKbUploading(false);
      setSelectedFile(null);
      inputEl.value = "";
    }
  }

  async function onRun() {
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

    const updateAssistantMessage = (updater: (message: ChatBubble) => ChatBubble) => {
      setThread((currentThread) =>
        currentThread.map((message) =>
          message.id === assistantMsg.id ? updater(message) : message
        )
      );
    };

    const streamAgentResponse = async (body: {
      threadId?: string | null;
      message?: string;
      webSearchDecision?: "confirm" | "cancel";
    }) => {
      const res = await fetch(`${BASE}/agent/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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

          if (!parsed) {
            continue;
          }

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

        if (done) {
          break;
        }
      }
    };

    setThread((t) => [...t, userMsg, assistantMsg]);
    setInput("");
    setLoading(true);

    try {
      await streamAgentResponse({
        threadId,
        message: userContent,
      });
    } catch (e) {
      console.log(e);
      updateAssistantMessage((message) => ({
        ...message,
        content: message.content || "Something went wrong",
        pendingAction: null,
      }));
    } finally {
      setLoading(false);
    }
  }

  async function resumePendingWebSearch(
    assistantMessageId: string,
    decision: "confirm" | "cancel"
  ) {
    if (loading || !threadId) return;

    const updateAssistantMessage = (updater: (message: ChatBubble) => ChatBubble) => {
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
      const res = await fetch(`${BASE}/agent/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          threadId,
          webSearchDecision: decision,
        }),
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

          if (!parsed) {
            continue;
          }

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

        if (done) {
          break;
        }
      }
    } catch (e) {
      console.log(e);
      updateAssistantMessage((message) => ({
        ...message,
        content: "Something went wrong",
        pendingAction: null,
      }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-linear-to-b from-slate-50 to-slate-100">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-purple-600">
              <span className="text-white font-bold text-sm">AG</span>
            </div>
            <h1 className="text-lg font-semibold text-slate-900">Agent</h1>
          </div>
          <Button
            onClick={() => setShowUploadPanel(!showUploadPanel)}
            variant="outline"
            className="gap-2"
          >
            <UploadIcon className="h-4 w-4" />
            Upload KB
          </Button>
        </div>
      </div>

      {/* main content */}
      <div className="flex-1 flex overflow-auto">
        {/* chat area */}
        <div className="flex-1 flex flex-col">
          <ScrollArea className="flex-1">
            <div className="max-w-3xl mx-auto space-y-4 pb-4">
              {thread.length === 0 && !loading && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center space-y-4 mt-32">
                    <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-blue-500 to-purple-600 mx-auto flex items-center justify-center">
                      <UploadIcon className="w-8 h-8 text-white" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-semibold text-slate-950 mb-2">
                        Welcome to Agent
                      </h2>
                      <p className="text-slate-600">
                        Upload your docs and ask queries based on your own
                        knowledge base
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {thread.map((m, i) => (
                <ChatRow 
                  key={m.id} 
                  msg={m} 
                  isLoading={loading && i === thread.length - 1} 
                  isLastAssistantMessage={i === thread.length - 1 && m.role === "assistant"}
                  onConfirmWebSearch={() => resumePendingWebSearch(m.id, "confirm")}
                  onCancelWebSearch={() => resumePendingWebSearch(m.id, "cancel")}
                  interactionDisabled={loading}
                />
              ))}
            </div>
          </ScrollArea>

          <div className="flex-shrink-0 border-t border-slate-200 bg-white p-5 md:p-6">
            <div className="max-w-3xl mx-auto space-y-3">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask anything about your uploaded docs..."
                disabled={loading}
                className="resize-none min-h-[100px] rounded-xl border-slate-400 bg-slate-50"
              />
              <div className="flex items-center justify-end">
                <Button
                  onClick={onRun}
                  disabled={loading}
                  className="gap-2 rounded-lg bg-linear-to-br from-blue-500 to-purple-600 text-white"
                >
                  {loading ? "Thinking..." : "Send"}
                  <Send className="w-5 h-5" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        {showUploadPanel && (
          <div className="w-96 border-l border-slate-200 flex flex-col overflow-hidden">
            <div className="border-b border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-slate-900">Knowledge Base</h2>
                <button
                  className="bg-linear-to-br from-blue-500 p-2 to-purple-600 text-white"
                  onClick={() => setShowUploadPanel(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 p-4 flex flex-col gap-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
                <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-4">
                  <label
                    htmlFor="file-upload"
                    className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${kbUploading ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-slate-100"}`}
                  >
                    <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m0-3v12" />
                    </svg>
                    <span className="text-sm text-slate-600 flex-1">
                      {kbUploading
                        ? selectedFile
                          ? selectedFile
                          : "Uploading..."
                        : selectedFile || "Click to upload file..."}
                    </span>
                  </label>
                  <input
                    type="file"
                    accept=".pdf,.txt,.md, application/pdf, text/plain, text/markdown"
                    onChange={onFileInput}
                    id="file-upload"
                    disabled={kbUploading}
                    className="hidden"
                  />
                </div>
                {uploadMsg && (
                  <div
                    className={`flex items-center gap-2 text-xs ${
                      uploadStatus === "success"
                        ? "text-green-700"
                        : uploadStatus === "skipped"
                          ? "text-amber-700"
                          : uploadStatus === "error"
                            ? "text-red-700"
                            : "text-slate-600"
                    }`}
                  >
                    {uploadStatus === "uploading" && (
                      <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
                    )}
                    {uploadStatus === "success" && (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    )}
                    {uploadStatus === "skipped" && (
                      <Info className="h-4 w-4 text-amber-600" />
                    )}
                    {uploadStatus === "error" && (
                      <XCircle className="h-4 w-4 text-red-600" />
                    )}
                    <span className="break-words">{uploadMsg}</span>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col min-h-0 flex-1">
                <div className="flex items-center justify-between mb-3">
                  <Label className="text-slate-700 font-semibold">
                    Uploaded Files
                  </Label>
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={async () => {
                      const ok = await checkKbHealth();
                      if (ok) fetchKbFiles();
                    }}
                    disabled={kbFilesLoading}
                  >
                    {kbFilesLoading ? "Loading..." : "Refresh"}
                  </Button>
                </div>

                {kbHealthError && (
                  <div className="text-xs text-red-600 mb-2">{kbHealthError}</div>
                )}

                {kbFilesError && (
                  <div className="text-xs text-red-600 mb-2">{kbFilesError}</div>
                )}

                {kbDeleteError && (
                  <div className="text-xs text-red-600 mb-2">{kbDeleteError}</div>
                )}

                <ScrollArea className="flex-1 min-h-0">
                  {!kbFilesError && kbFiles.length === 0 && (
                    <div className="text-xs text-slate-500">No files yet</div>
                  )}

                  {kbFiles.length > 0 && (
                    <div className="space-y-2 w-full">
                      {kbFiles.map((f) => (
                        <div
                          key={f.id ? `id:${f.id}` : `${f.name}-${f.sha256 ?? ""}`}
                          className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <div className="truncate text-sm text-slate-800">
                              {f.name}
                            </div>
                            <div className="text-xs text-slate-500">
                              {typeof f.chunkCount === "number"
                                ? `${f.chunkCount} chunks`
                                : "chunks: -"}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {f.sha256 && (
                              <Badge
                                variant={"secondary"}
                                className="text-[10px] bg-slate-100 text-slate-700"
                              >
                                sha256
                              </Badge>
                            )}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              disabled={
                                kbDeletingKey ===
                                  (f.id ||
                                    `${f.name}::${f.sha256 ?? ""}::legacy`) ||
                                kbFilesLoading
                              }
                              onClick={() => deleteKbFile(f)}
                              aria-label={`Delete ${f.name}`}
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChatRow({
  msg,
  isLoading,
  isLastAssistantMessage,
  onConfirmWebSearch,
  onCancelWebSearch,
  interactionDisabled,
}: {
  msg: ChatBubble;
  isLoading?: boolean;
  isLastAssistantMessage?: boolean;
  onConfirmWebSearch?: () => void;
  onCancelWebSearch?: () => void;
  interactionDisabled?: boolean;
}) {
  const isUser = msg.role === "user";
  const { displayText: typewriterText } = useTypewriter(msg.content, 10, !!isLastAssistantMessage);
  const displayContent = isLastAssistantMessage ? typewriterText : msg.content;
  const pendingStatus = msg.pendingAction?.status ?? "idle";
  const isSearchingWeb = pendingStatus === "searching";
  const isCancellingWebSearch = pendingStatus === "cancelling";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="flex gap-3 max-w-2xl">
        {!isUser && (
          <div className="w-8 h-8 rounded-lg bg-linear-to-br from-blue-500 to-purple-600 shrink-0 flex items-center justify-center">
            <span className="text-white text-xs font-bold">AG</span>
          </div>
        )}

        <div
          className={`rounded-xl px-4 py-4 text-sm leading-relaxed
           ${isUser ? "bg-blue-500 text-white" : "bg-slate-100 text-slate-900"
            } `}
        >
          {displayContent ? (
            <div className="whitespace-pre-wrap">
              {displayContent}
            </div>
          ) : (
            isLoading && !isUser && (
              <div className="flex gap-1.5 py-1 items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" />
                <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0.2s]" />
                <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0.4s]" />
              </div>
            )
          )}

          {!isUser && msg.citations && msg.citations.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {msg.citations.map((c, i) => (
                c.url ? (
                  <a
                    key={i}
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex"
                  >
                    <Badge
                      variant={"secondary"}
                      className="text-xs bg-slate-100 text-slate-700 hover:bg-slate-200"
                    >
                      {c.source}
                    </Badge>
                  </a>
                ) : (
                  <Badge
                    key={i}
                    variant={"secondary"}
                    className="text-xs bg-slate-100 text-slate-700"
                  >
                    {c.source}
                  </Badge>
                )
              ))}
            </div>
          )}

          {!isUser && msg.pendingAction && (
            <div className="mt-4 overflow-hidden rounded-xl border border-blue-200 bg-white shadow-sm">
              <div className="bg-linear-to-r from-blue-50 to-purple-50 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  {isSearchingWeb || isCancellingWebSearch ? (
                    <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                  ) : (
                    <Info className="h-4 w-4 text-blue-600" />
                  )}
                  <span>
                    {isSearchingWeb
                      ? "正在联网搜索..."
                      : isCancellingWebSearch
                        ? "正在取消联网搜索..."
                        : "需要你的确认"}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  {isSearchingWeb
                    ? "已开始联网检索公开网页内容，马上继续生成答案。"
                    : isCancellingWebSearch
                      ? "正在结束本次联网搜索请求。"
                      : "当前知识库结果不足，是否切换到互联网搜索结果继续回答。"}
                </div>
              </div>

              <div className="space-y-3 px-4 py-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                  {msg.pendingAction.message}
                </div>

                <div className="space-y-1 text-xs text-slate-600">
                  <div>
                    {msg.pendingAction.reason === "no_retrieval"
                      ? "当前知识库没有检索到可回答的内容。"
                      : "当前知识库结果置信度偏低。"}
                  </div>
                  {msg.pendingAction.reason === "low_confidence" &&
                    typeof msg.pendingAction.confidence === "number" && (
                    <div>检索置信度：{msg.pendingAction.confidence.toFixed(3)}</div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Button
                    size="sm"
                    onClick={onConfirmWebSearch}
                    disabled={interactionDisabled || isSearchingWeb || isCancellingWebSearch}
                    className="h-10 bg-linear-to-br from-blue-500 to-purple-600 text-white shadow-sm hover:from-blue-600 hover:to-purple-700"
                  >
                    {isSearchingWeb ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在联网搜索
                      </span>
                    ) : (
                      msg.pendingAction.confirmLabel
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onCancelWebSearch}
                    disabled={interactionDisabled || isSearchingWeb || isCancellingWebSearch}
                    className="h-10 border-slate-300 bg-white"
                  >
                    {isCancellingWebSearch ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在取消
                      </span>
                    ) : (
                      msg.pendingAction.cancelLabel
                    )}
                  </Button>
                </div>

                {(isSearchingWeb || isCancellingWebSearch) && (
                  <div className="text-xs text-slate-500">
                    {isSearchingWeb
                      ? "正在调用互联网搜索并整理结果，请稍等。"
                      : "正在返回取消状态，请稍等。"}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
