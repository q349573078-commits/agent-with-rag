import { Router } from "express";
import { mkdir, unlink } from "fs/promises";
import { extname } from "path";
import { createHash } from "crypto";
import multer, { MulterError } from "multer";
import { nanoid } from "nanoid";
import {
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
  ObjectId,
} from "mongodb";
import { loadFileAsDocuments } from "../kb/01_loaders";
import { splitDocuments } from "../kb/02_splitter";
import { ingestDocuments } from "../kb/04_ingest";
import { getKbCollection, getKbFilesCollection } from "../kb/03_vectorStore";
import { getMongoConnectionInfo, MongoDnsHijackError } from "../utils/mongo";

export const kbRouter = Router();

const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;
const uploadDir = "uploads";
const allowedExtensions = new Set([".pdf", ".txt", ".md", ".markdown"]);
const allowedMimeTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

class UploadValidationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.statusCode = statusCode;
  }
}

function isSupportedUpload(file: Express.Multer.File): boolean {
  const extension = extname(file.originalname).toLowerCase();
  return (
    allowedExtensions.has(extension) || allowedMimeTypes.has(file.mimetype)
  );
}

function getUploadErrorResponse(error: unknown): {
  statusCode: number;
  message: string;
} {
  if (error instanceof UploadValidationError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
    };
  }

  if (error instanceof MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return {
        statusCode: 400,
        message: "File is too large. Maximum size is 20MB.",
      };
    }

    return {
      statusCode: 400,
      message: error.message,
    };
  }

  if (
    error instanceof MongoServerSelectionError ||
    error instanceof MongoNetworkError
  ) {
    return {
      statusCode: 503,
      message:
        "MongoDB is unavailable. Please check MONGODB_ATLAS_URI / MONGODB_DB_NAME, Atlas IP Access List, and network access to port 27017.",
    };
  }

  if (error instanceof MongoDnsHijackError) {
    return {
      statusCode: 503,
      message: `MongoDB DNS resolution looks wrong for ${error.host}: ${error.resolvedIps.join(
        ", "
      )}. Switch network/VPN or change DNS to 1.1.1.1/8.8.8.8 and enable DoH.`,
    };
  }

  return {
    statusCode: 500,
    message: "Something went wrong while uploading the file",
  };
}

function getKbFilesErrorResponse(error: unknown): {
  statusCode: number;
  message: string;
} {
  if (
    error instanceof MongoServerSelectionError ||
    error instanceof MongoNetworkError
  ) {
    return {
      statusCode: 503,
      message:
        "MongoDB is unavailable. Please check MONGODB_ATLAS_URI / MONGODB_DB_NAME, Atlas IP Access List, and network access to port 27017.",
    };
  }

  if (error instanceof MongoDnsHijackError) {
    return {
      statusCode: 503,
      message: `MongoDB DNS resolution looks wrong for ${error.host}: ${error.resolvedIps.join(
        ", "
      )}. Switch network/VPN or change DNS to 1.1.1.1/8.8.8.8 and enable DoH.`,
    };
  }

  return {
    statusCode: 500,
    message: "Something went wrong while loading KB files",
  };
}

function normalizeKbFileName(name: string): string {
  return name.trim();
}

async function computeSha256(filePath: string): Promise<string> {
  const { readFile } = await import("fs/promises");
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function getErrorInfo(error: unknown): { name?: string; message?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: typeof error === "string" ? error : undefined,
  };
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!isSupportedUpload(file)) {
      cb(
        new UploadValidationError(
          "Unsupported file type. Please upload a PDF, TXT, or Markdown file."
        )
      );
      return;
    }

    cb(null, true);
  },
});

kbRouter.get("/health", async (_req, res) => {
  const mongo = getMongoConnectionInfo();

  try {
    const collection = await getKbCollection();
    await collection.db.command({ ping: 1 });

    return res.status(200).json({
      ok: true,
      mongo: {
        ok: true,
        ...mongo,
      },
    });
  } catch (error) {
    const { statusCode, message } = getKbFilesErrorResponse(error);

    return res.status(statusCode).json({
      ok: false,
      mongo: {
        ok: false,
        ...mongo,
      },
      message,
    });
  }
});

kbRouter.get("/files", async (_req, res) => {
  let stage: "query_kb_files" | "query_kb_chunks_distinct" = "query_kb_files";

  try {
    const filesCollection = await getKbFilesCollection();
    const docs = await filesCollection
      .find(
        {},
        {
          projection: {
            _id: 1,
            originalName: 1,
            normalizedName: 1,
            sha256: 1,
            uploadedAt: 1,
            chunkCount: 1,
          },
        }
      )
      .sort({ uploadedAt: -1 })
      .limit(500)
      .toArray();

    if (docs.length > 0) {
      return res.status(200).json({
        ok: true,
        files: docs.map((doc: any) => ({
          id:
            doc?._id && typeof doc._id.toHexString === "function"
              ? doc._id.toHexString()
              : null,
          name: doc.originalName ?? doc.normalizedName ?? "unknown",
          uploadedAt: doc.uploadedAt ?? null,
          chunkCount: typeof doc.chunkCount === "number" ? doc.chunkCount : null,
          sha256: doc.sha256 ?? null,
        })),
      });
    }

    stage = "query_kb_chunks_distinct";
    const chunksCollection = await getKbCollection();
    const sources = (await chunksCollection.distinct("source"))
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .sort((a, b) => a.localeCompare(b));

    return res.status(200).json({
      ok: true,
      legacy: true,
      files: sources.map((name) => ({ name, legacy: true })),
    });
  } catch (error) {
    const errorId = nanoid(10);
    const { name, message: errorMessage } = getErrorInfo(error);
    console.error(`[kb.files] errorId=${errorId} stage=${stage}`, error);

    const { statusCode, message } = getKbFilesErrorResponse(error);

    return res.status(statusCode).json({
      ok: false,
      message,
      errorId,
      stage,
      errorName: name,
      errorMessage,
    });
  }
});

kbRouter.delete("/files/:id", async (req, res) => {
  let stage:
    | "validate_params"
    | "query_kb_files"
    | "delete_kb_chunks"
    | "delete_kb_files" = "validate_params";

  try {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid file id",
      });
    }

    const fileObjectId = new ObjectId(id);

    stage = "query_kb_files";
    const filesCollection = await getKbFilesCollection();
    const fileDoc = await filesCollection.findOne(
      { _id: fileObjectId },
      { projection: { originalName: 1, normalizedName: 1, sha256: 1 } }
    );

    stage = "delete_kb_chunks";
    const chunksCollection = await getKbCollection();

    const chunkFilters: Record<string, unknown>[] = [{ "metadata.fileId": id }];

    if (fileDoc) {
      const sha256 = (fileDoc as any).sha256;
      const normalizedName = (fileDoc as any).normalizedName;
      const originalName = (fileDoc as any).originalName;

      if (typeof sha256 === "string" && sha256.trim().length > 0) {
        chunkFilters.push({ "metadata.sha256": sha256.trim() });
      }

      if (
        typeof normalizedName === "string" &&
        normalizedName.trim().length > 0
      ) {
        chunkFilters.push({ "metadata.normalizedName": normalizedName.trim() });
      }

      if (
        typeof originalName === "string" &&
        originalName.trim().length > 0
      ) {
        chunkFilters.push({ source: originalName.trim() });
        chunkFilters.push({ "metadata.source": originalName.trim() });
      }
    }

    const chunksRes = await chunksCollection.deleteMany({
      $or: chunkFilters,
    });

    stage = "delete_kb_files";
    const fileRes = await filesCollection.deleteOne({ _id: fileObjectId });

    return res.status(200).json({
      ok: true,
      deleted: {
        files: fileRes.deletedCount ?? 0,
        chunks: chunksRes.deletedCount ?? 0,
      },
      notFound: !fileDoc,
    });
  } catch (error) {
    const errorId = nanoid(10);
    const { name, message: errorMessage } = getErrorInfo(error);
    console.error(`[kb.files.delete] errorId=${errorId} stage=${stage}`, error);

    const { statusCode, message } = getKbFilesErrorResponse(error);

    return res.status(statusCode).json({
      ok: false,
      message,
      errorId,
      stage,
      errorName: name,
      errorMessage,
    });
  }
});

kbRouter.delete("/files", async (req, res) => {
  let stage:
    | "validate_query"
    | "query_kb_files"
    | "delete_kb_chunks"
    | "delete_kb_files" = "validate_query";

  try {
    const nameQuery = typeof req.query.name === "string" ? req.query.name : null;
    const hashQuery = typeof req.query.hash === "string" ? req.query.hash : null;

    if (!nameQuery && !hashQuery) {
      return res.status(400).json({
        ok: false,
        message: "Missing query param: provide ?name=... or ?hash=...",
      });
    }

    const normalizedNameRaw = nameQuery ? normalizeKbFileName(nameQuery) : null;
    const normalizedHashRaw = hashQuery ? hashQuery.trim() : null;
    const normalizedName =
      normalizedNameRaw && normalizedNameRaw.trim().length > 0
        ? normalizedNameRaw.trim()
        : null;
    const normalizedHash =
      normalizedHashRaw && normalizedHashRaw.trim().length > 0
        ? normalizedHashRaw.trim()
        : null;

    if (!normalizedName && !normalizedHash) {
      return res.status(400).json({
        ok: false,
        message: "Invalid query param: name/hash is empty",
      });
    }

    stage = "query_kb_files";
    const filesCollection = await getKbFilesCollection();

    const fileDocs = await filesCollection
      .find(
        normalizedHash
          ? { sha256: normalizedHash }
          : normalizedName
            ? {
                $or: [
                  { originalName: normalizedName },
                  { normalizedName: normalizedName },
                ],
              }
            : { _id: new ObjectId("000000000000000000000000") },
        { projection: { _id: 1, originalName: 1, normalizedName: 1, sha256: 1 } }
      )
      .limit(50)
      .toArray();

    stage = "delete_kb_chunks";
    const chunksCollection = await getKbCollection();
    const chunkFilters: Record<string, unknown>[] = [];

    for (const doc of fileDocs as any[]) {
      if (doc?._id && typeof doc._id.toHexString === "function") {
        chunkFilters.push({ "metadata.fileId": doc._id.toHexString() });
      }
    }

    if (normalizedHash) {
      chunkFilters.push({ "metadata.sha256": normalizedHash });
    }

    if (normalizedName) {
      chunkFilters.push({ source: normalizedName });
      chunkFilters.push({ "metadata.source": normalizedName });
      chunkFilters.push({ "metadata.normalizedName": normalizedName });
    }

    const chunksRes =
      chunkFilters.length > 0
        ? await chunksCollection.deleteMany({ $or: chunkFilters })
        : { deletedCount: 0 };

    stage = "delete_kb_files";
    const fileRes = normalizedHash
      ? await filesCollection.deleteMany({ sha256: normalizedHash })
      : normalizedName
        ? await filesCollection.deleteMany({
            $or: [{ originalName: normalizedName }, { normalizedName: normalizedName }],
          })
        : { deletedCount: 0 };

    return res.status(200).json({
      ok: true,
      deleted: {
        files: (fileRes as any).deletedCount ?? 0,
        chunks: chunksRes.deletedCount ?? 0,
      },
    });
  } catch (error) {
    const errorId = nanoid(10);
    const { name, message: errorMessage } = getErrorInfo(error);
    console.error(
      `[kb.files.deleteByQuery] errorId=${errorId} stage=${stage}`,
      error
    );

    const { statusCode, message } = getKbFilesErrorResponse(error);

    return res.status(statusCode).json({
      ok: false,
      message,
      errorId,
      stage,
      errorName: name,
      errorMessage,
    });
  }
});

kbRouter.get("/files/exists", async (req, res) => {
  let stage:
    | "validate_query"
    | "query_kb_files"
    | "query_kb_chunks_fallback" = "validate_query";

  try {
    const nameQuery = typeof req.query.name === "string" ? req.query.name : null;
    const hashQuery = typeof req.query.hash === "string" ? req.query.hash : null;

    if (!nameQuery && !hashQuery) {
      return res.status(400).json({
        ok: false,
        message: "Missing query param: provide ?name=... or ?hash=...",
      });
    }

    const normalizedName = nameQuery ? normalizeKbFileName(nameQuery) : null;
    const normalizedHash = hashQuery ? hashQuery.trim() : null;

    stage = "query_kb_files";
    const filesCollection = await getKbFilesCollection();

    const fileDoc = await filesCollection.findOne(
      normalizedHash
        ? { sha256: normalizedHash }
        : {
            $or: [
              { originalName: normalizedName },
              { normalizedName: normalizedName },
            ],
          },
      { projection: { _id: 0, originalName: 1, normalizedName: 1, sha256: 1 } }
    );

    if (fileDoc) {
      return res.status(200).json({
        ok: true,
        exists: true,
        matchBy: normalizedHash ? "hash" : "name",
        file: {
          name: (fileDoc as any).originalName ?? (fileDoc as any).normalizedName,
          sha256: (fileDoc as any).sha256 ?? null,
        },
      });
    }

    if (!normalizedHash && normalizedName) {
      stage = "query_kb_chunks_fallback";
      const chunksCollection = await getKbCollection();
      const legacyChunk = await chunksCollection.findOne(
        { source: normalizedName },
        { projection: { _id: 1 } }
      );

      if (legacyChunk) {
        return res.status(200).json({
          ok: true,
          exists: true,
          matchBy: "name",
          legacy: true,
          file: { name: normalizedName, sha256: null },
        });
      }
    }

    return res.status(200).json({
      ok: true,
      exists: false,
      matchBy: normalizedHash ? "hash" : "name",
    });
  } catch (error) {
    const errorId = nanoid(10);
    const { name, message: errorMessage } = getErrorInfo(error);
    console.error(`[kb.files.exists] errorId=${errorId} stage=${stage}`, error);

    const { statusCode, message } = getKbFilesErrorResponse(error);

    return res.status(statusCode).json({
      ok: false,
      message,
      errorId,
      stage,
      errorName: name,
      errorMessage,
    });
  }
});

kbRouter.post("/upload", async (req, res) => {
  let uploadedFilePath: string | null = req.file?.path ?? null;
  let reservedFileId: ObjectId | null = null;
  let stage:
    | "multer"
    | "decode_filename"
    | "compute_hash"
    | "dedupe_check"
    | "load_documents"
    | "split_documents"
    | "reserve_file"
    | "ingest_documents"
    | "finalize_file"
    | "cleanup" = "multer";

  try {
    await mkdir(uploadDir, { recursive: true });

    stage = "multer";
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    uploadedFilePath = req.file?.path ?? null;

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "No file uploaded.Please upload a file before proceeding!",
      });
    }
    const { path, mimetype, originalname } = req.file;

    let decodedName = originalname;
    stage = "decode_filename";
    try {
      decodedName = Buffer.from(originalname, "latin1").toString("utf-8");
    } catch (e) {
      try {
        decodedName = decodeURIComponent(originalname);
      } catch (e2) {
        decodedName = originalname;
      }
    }

    stage = "load_documents";
    const normalizedName = normalizeKbFileName(decodedName);

    stage = "compute_hash";
    let sha256: string | null = null;
    try {
      sha256 = await computeSha256(path);
    } catch {
      sha256 = null;
    }

    stage = "dedupe_check";
    const filesCollection = await getKbFilesCollection();
    if (sha256) {
      const existing = await filesCollection.findOne(
        { sha256 },
        {
          projection: {
            _id: 1,
            originalName: 1,
            normalizedName: 1,
            sha256: 1,
          },
        }
      );

      if (existing) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "duplicate",
          matchBy: "hash",
          file: {
            name: (existing as any).originalName ?? (existing as any).normalizedName,
            sha256: (existing as any).sha256 ?? sha256,
          },
        });
      }
    } else {
      const existing = await filesCollection.findOne(
        { $or: [{ originalName: decodedName }, { normalizedName }] },
        { projection: { _id: 1, originalName: 1, normalizedName: 1 } }
      );

      if (existing) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "duplicate",
          matchBy: "name",
          file: {
            name: (existing as any).originalName ?? (existing as any).normalizedName,
            sha256: null,
          },
        });
      }
    }

    stage = "reserve_file";
    if (sha256) {
      reservedFileId = new ObjectId();
      try {
        await filesCollection.insertOne({
          _id: reservedFileId,
          originalName: decodedName,
          normalizedName,
          sha256,
          uploadedAt: new Date(),
          chunkCount: 0,
        });
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
          return res.status(200).json({
            ok: true,
            skipped: true,
            reason: "duplicate",
            matchBy: "hash",
            file: {
              name: decodedName,
              sha256,
            },
          });
        }
        throw error;
      }
    }

    const rawDocs = await loadFileAsDocuments({
      filePath: path,
      mimeType: mimetype,
      originalName: decodedName,
    });

    if (!rawDocs.length) {
      return res.status(400).json({
        ok: false,
        message: "Unsupported or empty file",
      });
    }

    stage = "split_documents";
    const chunks = await splitDocuments(rawDocs);

    if (!chunks.length) {
      return res.status(400).json({
        ok: false,
        message:
          "File loaded but produced no usable chunks after splitting is done",
      });
    }

    stage = "ingest_documents";
    const fileIdString = reservedFileId ? reservedFileId.toHexString() : null;
    const chunksWithFileMeta = chunks.map((chunk) => ({
      ...chunk,
      metadata: {
        ...(chunk.metadata ?? {}),
        fileId: fileIdString,
        sha256,
        normalizedName,
      },
    }));

    const summary = await ingestDocuments(chunksWithFileMeta);

    stage = "finalize_file";
    if (reservedFileId) {
      await filesCollection.updateOne(
        { _id: reservedFileId },
        {
          $set: {
            originalName: decodedName,
            normalizedName,
            sha256,
            chunkCount: summary.totalChunks,
          },
        }
      );
    }

    return res.status(200).json({
      ok: summary.ok,
      totalChunks: summary.totalChunks,
      sources: summary.sources,
      file: {
        id: reservedFileId ? reservedFileId.toHexString() : null,
        name: decodedName,
        sha256,
      },
    });
  } catch (error) {
    const errorId = nanoid(10);
    const { name, message: errorMessage } = getErrorInfo(error);
    console.error(`[kb.upload] errorId=${errorId} stage=${stage}`, error);

    if (reservedFileId) {
      try {
        const filesCollection = await getKbFilesCollection();
        await filesCollection.deleteOne({ _id: reservedFileId });
      } catch (cleanupError) {
        console.warn("Failed to rollback kb_files record:", cleanupError);
      }
      reservedFileId = null;
    }

    const { statusCode, message } = getUploadErrorResponse(error);

    res.status(statusCode).json({
      message,
      errorId,
      stage,
      errorName: name,
      errorMessage,
      ok: false,
    });
  } finally {
    if (uploadedFilePath) {
      try {
        stage = "cleanup";
        await unlink(uploadedFilePath);
      } catch (cleanupError) {
        console.warn("Failed to delete uploaded temp file:", cleanupError);
      }
      uploadedFilePath = null;
    }
  }
});
