import { ScrollArea } from "@shared/components/ui/scroll-area";
import { Textarea } from "@shared/components/ui/textarea";
import { Button } from "@shared/components/ui/button";
import { UploadIcon, Send } from "lucide-react";
import { ChatRow } from "./ChatRow";
import type { ChatBubble } from "@shared/types/chat";

export function ChatArea({
  thread,
  loading,
  input,
  onInputChange,
  onSend,
  onResumeWebSearch,
  onCancelWebSearch,
}: {
  thread: ChatBubble[];
  loading: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onResumeWebSearch: (msgId: string) => void;
  onCancelWebSearch: (msgId: string) => void;
}) {
  return (
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
                    Upload your docs and ask queries based on your own knowledge
                    base
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
              isLastAssistantMessage={
                i === thread.length - 1 && m.role === "assistant"
              }
              onConfirmWebSearch={() => onResumeWebSearch(m.id)}
              onCancelWebSearch={() => onCancelWebSearch(m.id)}
              interactionDisabled={loading}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="flex-shrink-0 border-t border-slate-200 bg-white p-5 md:p-6">
        <div className="max-w-3xl mx-auto space-y-3">
          <Textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Ask anything about your uploaded docs..."
            disabled={loading}
            className="resize-none min-h-[100px] rounded-xl border-slate-400 bg-slate-50"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          <div className="flex items-center justify-end">
            <Button
              onClick={onSend}
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
  );
}
