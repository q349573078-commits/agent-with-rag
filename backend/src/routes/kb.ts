import { Router } from "express";
import { mkdir, unlink } from "fs/promises";
import { extname } from "path";
import multer, { MulterError } from "multer";
import { nanoid } from "nanoid";
import { MongoNetworkError, MongoServerSelectionError } from "mongodb";
import { loadFileAsDocuments } from "../kb/01_loaders";
import { splitDocuments } from "../kb/02_splitter";
import { ingestDocuments } from "../kb/04_ingest";
import { MongoDnsHijackError } from "../utils/mongo";

export const kbRouter = Router();

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
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
        message: "File is too large. Maximum size is 10MB.",
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

kbRouter.post("/upload", async (req, res) => {
  let uploadedFilePath: string | null = req.file?.path ?? null;
  let stage:
    | "multer"
    | "decode_filename"
    | "load_documents"
    | "split_documents"
    | "ingest_documents"
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
    const summary = await ingestDocuments(chunks);

    return res.status(200).json({
      ok: summary.ok,
      totalChunks: summary.totalChunks,
      sources: summary.sources,
    });
  } catch (error) {
    const errorId = nanoid(10);
    const { name, message: errorMessage } = getErrorInfo(error);
    console.error(`[kb.upload] errorId=${errorId} stage=${stage}`, error);

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
