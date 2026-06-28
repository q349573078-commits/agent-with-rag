import { Label } from "@shared/components/ui/label";
import { Loader2, CheckCircle2, Info, XCircle } from "lucide-react";
import type { UploadStatus } from "../hooks/use-kb-files";

export function KbUpload({
  selectedFile,
  kbUploading,
  uploadMsg,
  uploadStatus,
  onFileSelect,
}: {
  selectedFile: string | null;
  kbUploading: boolean;
  uploadMsg: string | null;
  uploadStatus: UploadStatus;
  onFileSelect: (file: File) => void;
}) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
    e.target.value = "";
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
      <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-4">
        <label
          htmlFor="file-upload"
          className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${
            kbUploading
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer hover:bg-slate-100"
          }`}
        >
          <svg
            className="w-5 h-5 text-slate-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m0-3v12"
            />
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
          onChange={handleChange}
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
  );
}
