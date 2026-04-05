import { Router } from "express";
import multer from "multer";
import { loadFileAsDocuments } from "../kb/01_loaders";
import { splitDocuments } from "../kb/02_splitter";
import { ingestDocuments } from "../kb/04_ingest";

export const kbRouter = Router();

const upload = multer({
  dest: "uploads/",
  limits: {
    fieldSize: 10 * 1021 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    // Preserve original filename with proper encoding
    cb(null, true);
  },
});

kbRouter.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "No file uploaded.Please upload a file before proceeding!",
      });
    }
    //dummy.pdf
    const { path, mimetype, originalname } = req.file;

    // Try to decode filename - handle various encodings
    let decodedName = originalname;
    try {
      // First try UTF-8 decoding (for Chinese, Japanese, Korean characters)
      decodedName = Buffer.from(originalname, 'latin1').toString('utf-8');
    } catch (e) {
      // If that fails, try URL decoding
      try {
        decodedName = decodeURIComponent(originalname);
      } catch (e2) {
        // Fall back to original name
        decodedName = originalname;
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
        message: "Upsupported or empty file",
      });
    }

    const chunks = await splitDocuments(rawDocs);

    if (!chunks.length) {
      return res.status(400).json({
        ok: false,
        message:
          "File loaded but produced no usable chunks after splitting is done",
      });
    }

    // ingest to our vector store
    const summary = await ingestDocuments(chunks);

    return res.status(200).json({
      ok: summary.ok,
      totalChunks: summary.totalChunks,
      sources: summary.sources,
    });
  } catch (e) {
    console.log(e);
    res.status(500).json({
      message: "Something went wrong while uploading the file",
      ok: false,
    });
  }
});
