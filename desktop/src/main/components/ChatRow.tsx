import { Button } from "@shared/components/ui/button";
import { Badge } from "@shared/components/ui/badge";
import { useTypewriter } from "@shared/hooks/use-typewriter";
import { Info, Loader2 } from "lucide-react";
import type { ChatBubble } from "@shared/types/chat";

export function ChatRow({
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
  const { displayText: typewriterText } = useTypewriter(
    msg.content,
    10,
    !!isLastAssistantMessage
  );
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
           ${isUser ? "bg-blue-500 text-white" : "bg-slate-100 text-slate-900"}`}
        >
          {displayContent ? (
            <div className="whitespace-pre-wrap">{displayContent}</div>
          ) : (
            isLoading &&
            !isUser && (
              <div className="flex gap-1.5 py-1 items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" />
                <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0.2s]" />
                <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0.4s]" />
              </div>
            )
          )}

          {!isUser && msg.citations && msg.citations.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {msg.citations.map((c, i) =>
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
              )}
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
                      <div>
                        检索置信度：{msg.pendingAction.confidence.toFixed(3)}
                      </div>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Button
                    size="sm"
                    onClick={onConfirmWebSearch}
                    disabled={
                      interactionDisabled ||
                      isSearchingWeb ||
                      isCancellingWebSearch
                    }
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
                    disabled={
                      interactionDisabled ||
                      isSearchingWeb ||
                      isCancellingWebSearch
                    }
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
