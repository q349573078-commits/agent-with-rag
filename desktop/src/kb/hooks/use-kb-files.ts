import { useCallback, useState } from "react";
import { getApiBaseUrl } from "@shared/config";
import { sha256Hex } from "@shared/lib/helpers";
import type { KbFileListItem } from "@shared/types/chat";

export type UploadStatus =
  | "idle"
  | "uploading"
  | "success"
  | "error"
  | "skipped";

export function useKbFiles() {
  const BASE = getApiBaseUrl();

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
            chunkCount:
              typeof f?.chunkCount === "number" ? f.chunkCount : null,
            sha256:
              typeof f?.sha256 === "string" || f?.sha256 === null
                ? f.sha256
                : null,
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
      const deletingKey =
        file.id || `${file.name}::${file.sha256 ?? ""}::legacy`;
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

  const checkAlreadyUploaded = useCallback(
    async (
      file: File
    ): Promise<{ exists: boolean; matchBy: "hash" | "name" }> => {
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
    },
    [BASE]
  );

  const uploadFile = useCallback(
    async (file: File) => {
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
            (typeof json?.message === "string" &&
            json.message.trim().length > 0
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
    },
    [BASE, fetchKbFiles]
  );

  const handleFileInput = useCallback(
    async (file: File) => {
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
      }
    },
    [checkAlreadyUploaded, uploadFile, fetchKbFiles]
  );

  return {
    uploadMsg,
    uploadStatus,
    ingestRes,
    selectedFile,
    kbUploading,
    kbFilesLoading,
    kbFilesError,
    kbDeleteError,
    kbDeletingKey,
    kbFiles,
    kbHealthError,
    checkKbHealth,
    fetchKbFiles,
    deleteKbFile,
    handleFileInput,
  };
}
