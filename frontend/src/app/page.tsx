"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Send, UploadIcon } from "lucide-react";
import { ChangeEvent, useState } from "react";
import { useTypewriter } from "@/hooks/use-typewriter";

type Citation = {
  source: string;
  preview: string;
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
    event: "error";
    data: {
      message: string;
    };
  };

type ChatBubble = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
};

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
  const [ingestRes, setIngestRes] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  async function uploadFile(file: File) {
    setUploadMsg("Uploading...");
    try {
      const fd = new FormData();
      fd.append("file", file);

      const BASE =
        process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5000";

      const res = await fetch(`${BASE}/kb/upload`, {
        method: "POST",
        body: fd,
      });

      const json = await res.json();
      setIngestRes(JSON.stringify(json, null, 2));

      if (res.ok && json.ok) {
        setUploadMsg("Uploaded and ingested into KB");
      } else {
        setUploadMsg("Upload or ingest failed");
      }
    } catch (e) {
      setUploadMsg("Upload Failed...");
    }
  }

  function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file.name);
      uploadFile(file);
    }
    e.currentTarget.value = "";
  }

  async function onRun() {
    if (!input.trim()) return;

    const userContent = input.trim();
    const userMsg: ChatBubble = { role: "user", content: userContent };
    const assistantMsg: ChatBubble = {
      role: "assistant",
      content: "",
      citations: [],
    };

    const updateAssistantMessage = (
      updater: (message: ChatBubble) => ChatBubble
    ) => {
      setThread((currentThread) => {
        const nextThread = [...currentThread];

        for (let index = nextThread.length - 1; index >= 0; index -= 1) {
          if (nextThread[index].role === "assistant") {
            nextThread[index] = updater(nextThread[index]);
            return nextThread;
          }
        }

        nextThread.push(updater(assistantMsg));
        return nextThread;
      });
    };

    setThread((t) => [...t, userMsg, assistantMsg]);
    setInput("");
    setLoading(true);

    try {
      const BASE =
        process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5000";

      const res = await fetch(`${BASE}/agent/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          threadId,
          message: userContent,
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
        content: message.content || "Something went wrong",
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
                  key={i} 
                  msg={m} 
                  isLoading={loading && i === thread.length - 1} 
                  isLastAssistantMessage={i === thread.length - 1 && m.role === "assistant"}
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
                className="resize-none min-h-[100px] rounded-xl border-slate-400 bg-slate-50"
              />
              <div className="flex items-center justify-end">
                <Button
                  onClick={onRun}
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

            <ScrollArea className="flex-1 p-4 space-y-4">
              <div className="space-y-2">
                <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-4">
                  <label
                    htmlFor="file-upload"
                    className="flex items-center gap-2 cursor-pointer p-2 hover:bg-slate-100 rounded-lg transition-colors"
                  >
                    <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m0-3v12" />
                    </svg>
                    <span className="text-sm text-slate-600 flex-1">
                      {selectedFile || "Click to upload file..."}
                    </span>
                  </label>
                  <input
                    type="file"
                    accept=".pdf,.txt,.md, application/pdf, text/plain, text/markdown"
                    onChange={onFileInput}
                    id="file-upload"
                    className="hidden"
                  />
                </div>
              </div>
              {uploadMsg && (
                <div className="p-3 text-sm text-slate-700">{uploadMsg}</div>
              )}

              {ingestRes && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <Label className="text-slate-700 font-semibold">Ingest Result</Label>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 overflow-x-auto">
                    <pre className="text-xs text-slate-700 font-mono whitespace-pre-wrap break-words">
                      {ingestRes}
                    </pre>
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
}

function ChatRow({ msg, isLoading, isLastAssistantMessage }: { msg: ChatBubble; isLoading?: boolean; isLastAssistantMessage?: boolean }) {
  const isUser = msg.role === "user";
  const { displayText: typewriterText } = useTypewriter(msg.content, 10, !!isLastAssistantMessage);
  const displayContent = isLastAssistantMessage ? typewriterText : msg.content;

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
                <Badge
                  key={i}
                  variant={"secondary"}
                  className="text-xs bg-slate-100 text-slate-700"
                >
                  {c.source}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
