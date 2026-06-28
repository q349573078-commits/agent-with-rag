export type Citation = {
  source: string;
  preview: string;
  url?: string;
  type?: "kb" | "web";
};

export type PendingWebSearchAction = {
  type: "web_search_confirmation";
  message: string;
  question: string;
  reason: "no_retrieval" | "low_confidence";
  confidence: number | null;
  confirmLabel: string;
  cancelLabel: string;
  status?: "idle" | "searching" | "cancelling";
};

export type StreamDoneEvent = {
  ok: boolean;
  threadId: string;
  answer: string;
  citations: Citation[];
};

export type StreamEvent =
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

export type ChatBubble = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  pendingAction?: PendingWebSearchAction | null;
};

export type KbFileListItem = {
  id?: string | null;
  name: string;
  uploadedAt?: string | null;
  chunkCount?: number | null;
  sha256?: string | null;
  legacy?: boolean;
};

export type UploadStatus = "idle" | "uploading" | "success" | "error" | "skipped";
