import { Label } from "@shared/components/ui/label";
import { Button } from "@shared/components/ui/button";
import { Badge } from "@shared/components/ui/badge";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { Trash2 } from "lucide-react";
import type { KbFileListItem } from "@shared/types/chat";

export function KbFileList({
  kbFiles,
  kbFilesLoading,
  kbFilesError,
  kbDeleteError,
  kbHealthError,
  kbDeletingKey,
  onRefresh,
  onDelete,
}: {
  kbFiles: KbFileListItem[];
  kbFilesLoading: boolean;
  kbFilesError: string | null;
  kbDeleteError: string | null;
  kbHealthError: string | null;
  kbDeletingKey: string | null;
  onRefresh: () => void;
  onDelete: (file: KbFileListItem) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col min-h-0 flex-1">
      <div className="flex items-center justify-between mb-3">
        <Label className="text-slate-700 font-semibold">Uploaded Files</Label>
        <Button
          variant="outline"
          className="h-8 px-3 text-xs"
          onClick={onRefresh}
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
                key={
                  f.id
                    ? `id:${f.id}`
                    : `${f.name}-${f.sha256 ?? ""}`
                }
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
                        (f.id || `${f.name}::${f.sha256 ?? ""}::legacy`) ||
                      kbFilesLoading
                    }
                    onClick={() => onDelete(f)}
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
  );
}
