import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP_SIZE = 120;
const SHORT_DOC_THRESHOLD = 500;
const LARGE_DOC_THRESHOLD = 4_000;
const HUGE_DOC_THRESHOLD = 12_000;

type SourceType = "markdown" | "pdf" | "text";

function getSourceType(source: unknown): SourceType {
  const normalized = typeof source === "string" ? source.toLowerCase() : "";

  if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) {
    return "markdown";
  }

  if (normalized.endsWith(".pdf")) {
    return "pdf";
  }

  return "text";
}

function getSeparators(sourceType: SourceType): string[] {
  const commonSeparators = [
    "\n\n",
    "\n",
    "。",
    "！",
    "？",
    ". ",
    "! ",
    "? ",
    "；",
    ";",
    "，",
    ",",
    " ",
    "",
  ];

  if (sourceType === "markdown") {
    return [
      "\n# ",
      "\n## ",
      "\n### ",
      "\n#### ",
      "\n##### ",
      "\n###### ",
      "\n```",
      "\n---\n",
      ...commonSeparators,
    ];
  }

  if (sourceType === "pdf") {
    return [
      "\n\n",
      "\n• ",
      "\n- ",
      "\n",
      ...commonSeparators.slice(2),
    ];
  }

  return commonSeparators;
}

function getChunkConfig(textLength: number, sourceType: SourceType) {
  if (textLength <= SHORT_DOC_THRESHOLD) {
    return null;
  }

  if (sourceType === "markdown") {
    if (textLength >= HUGE_DOC_THRESHOLD) {
      return { chunkSize: 1300, chunkOverlap: 180 };
    }

    if (textLength >= LARGE_DOC_THRESHOLD) {
      return { chunkSize: 1100, chunkOverlap: 160 };
    }

    return { chunkSize: 900, chunkOverlap: 120 };
  }

  if (sourceType === "pdf") {
    if (textLength >= HUGE_DOC_THRESHOLD) {
      return { chunkSize: 1200, chunkOverlap: 180 };
    }

    if (textLength >= LARGE_DOC_THRESHOLD) {
      return { chunkSize: 1000, chunkOverlap: 140 };
    }

    return { chunkSize: 850, chunkOverlap: 120 };
  }

  if (textLength >= HUGE_DOC_THRESHOLD) {
    return { chunkSize: 1200, chunkOverlap: 160 };
  }

  if (textLength >= LARGE_DOC_THRESHOLD) {
    return { chunkSize: 950, chunkOverlap: 120 };
  }

  return {
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP_SIZE,
  };
}

function normalizeChunk(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

async function splitSingleDocument(doc: Document): Promise<Document[]> {
  const baseMetadata = doc.metadata ?? {};
  const sourceType = getSourceType(baseMetadata.source);
  const normalizedContent = normalizeChunk(doc.pageContent);

  if (!normalizedContent) {
    return [];
  }

  const chunkConfig = getChunkConfig(normalizedContent.length, sourceType);

  if (!chunkConfig) {
    return [
      new Document({
        pageContent: normalizedContent,
        metadata: {
          ...baseMetadata,
          source: baseMetadata.source ?? "unknown_source",
          _sourceType: sourceType,
          _splitStrategy: "keep_whole",
        },
      }),
    ];
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: chunkConfig.chunkSize,
    chunkOverlap: chunkConfig.chunkOverlap,
    separators: getSeparators(sourceType),
  });

  const chunks = await splitter.splitDocuments([
    new Document({
      pageContent: normalizedContent,
      metadata: baseMetadata,
    }),
  ]);

  return chunks
    .map((chunk) => normalizeChunk(chunk.pageContent))
    .filter((chunk) => chunk.length > 0)
    .map(
      (pageContent) =>
        new Document({
          pageContent,
          metadata: {
            ...baseMetadata,
            source: baseMetadata.source ?? "unknown_source",
            _sourceType: sourceType,
            _splitStrategy: "adaptive_recursive",
            _chunkSize: chunkConfig.chunkSize,
            _chunkOverlap: chunkConfig.chunkOverlap,
          },
        })
    );
}

export async function splitDocuments(docs: Document[]): Promise<Document[]> {
  if (!docs.length) return [];

  const splitGroups = await Promise.all(docs.map((doc) => splitSingleDocument(doc)));
  let chunkIndex = 0;

  return splitGroups.flat().map((chunk) => {
    const base = chunk.metadata ?? {};

    return new Document({
      pageContent: chunk.pageContent,
      metadata: {
        ...base,
        source: base.source ?? "unknown_source",
        _chunkIndex: chunkIndex++,
      },
    });
  });
}
