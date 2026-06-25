import { Document } from "@langchain/core/documents";
import { MongoServerError } from "mongodb";
import { embeddings } from "../utils/openai";
import { env } from "../utils/env";
import { getKbCollection } from "./03_vectorStore";

export interface RetrieverResult {
  docs: Document[];
  confidence: number;
}

type ScoredChunk = [Document, number];
type StoredChunk = {
  text?: string;
  embedding?: number[];
  source?: string;
  chunkId?: number;
  metadata?: Record<string, unknown>;
};
type AtlasVectorChunk = Omit<StoredChunk, "embedding"> & {
  score?: number;
};

const VECTOR_SEARCH_NUM_CANDIDATE_MULTIPLIER = 20;
const VECTOR_SEARCH_FALLBACK_TTL_MS = 5 * 60 * 1000;
let atlasVectorSearchDisabledUntil = 0;

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index++) {
    dotProduct += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function scoreToConfidence(scores: number[]): number {
  const finiteScores = scores.filter((score) => Number.isFinite(score));
  if (!finiteScores.length) return 0;

  const maxScore = Math.max(...finiteScores);
  const bounded = Math.max(0, Math.min(1, maxScore));
  return Number(bounded.toFixed(2));
}

function atlasVectorSearchScoreToCosine(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }

  const normalizedScore = Math.max(0, Math.min(1, score));
  return normalizedScore * 2 - 1;
}

function chunkToDocument(chunk: StoredChunk | AtlasVectorChunk): Document {
  const text = typeof chunk.text === "string" ? chunk.text : "";
  const metadata = chunk.metadata ?? {};
  const source =
    chunk.source ??
    (typeof metadata.source === "string" ? metadata.source : "unknown_source");
  const chunkId =
    chunk.chunkId ??
    (typeof metadata.chunkId === "number" ? metadata.chunkId : 0);

  return new Document({
    pageContent: text,
    metadata: {
      ...metadata,
      source,
      chunkId,
    },
  });
}

function buildResult(results: ScoredChunk[]): RetrieverResult {
  if (!results.length) {
    return {
      docs: [],
      confidence: 0,
    };
  }

  const scores = results.map(([_, score]) => score);
  const confidence = scoreToConfidence(scores);
  const relevantResults = results.filter(
    ([_, score]) => score >= env.RETRIEVAL_MIN_SCORE
  );

  if (!relevantResults.length) {
    return {
      docs: [],
      confidence,
    };
  }

  const docs = relevantResults.map(([doc]) => doc);

  return { docs, confidence };
}

function isVectorSearchConfigurationError(error: unknown): boolean {
  if (!(error instanceof MongoServerError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("$vectorsearch") ||
    message.includes("vector search") ||
    message.includes("vectorsearch") ||
    (message.includes("index") && message.includes(env.KB_VECTOR_INDEX_NAME))
  );
}

function isAtlasVectorSearchTemporarilyDisabled(): boolean {
  return Date.now() < atlasVectorSearchDisabledUntil;
}

function disableAtlasVectorSearchTemporarily(): void {
  atlasVectorSearchDisabledUntil = Date.now() + VECTOR_SEARCH_FALLBACK_TTL_MS;
}

async function retrieveWithAppCosine(
  queryEmbedding: number[],
  k: number = 5
): Promise<RetrieverResult> {
  const collection = await getKbCollection();
  const storedChunks = (await collection
    .find(
      {
        text: { $type: "string" },
        embedding: { $type: "array" },
      },
      {
        projection: {
          text: 1,
          embedding: 1,
          source: 1,
          chunkId: 1,
          metadata: 1,
        },
      }
    )
    .toArray()) as StoredChunk[];

  const results = storedChunks
    .map((chunk) => {
      const embedding = Array.isArray(chunk.embedding) ? chunk.embedding : [];
      const score = cosineSimilarity(queryEmbedding, embedding);
      const doc = chunkToDocument(chunk);

      return [doc, score] as ScoredChunk;
    })
    .filter(([doc]) => doc.pageContent.trim().length > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, k);

  return buildResult(results);
}

async function retrieveWithAtlasVectorSearch(
  queryEmbedding: number[],
  k: number = 5
): Promise<RetrieverResult> {
  const collection = await getKbCollection();
  const numCandidates = Math.max(
    env.VECTOR_SEARCH_NUM_CANDIDATES,
    k * VECTOR_SEARCH_NUM_CANDIDATE_MULTIPLIER
  );
  const storedChunks = (await collection
    .aggregate([
      {
        $vectorSearch: {
          index: env.KB_VECTOR_INDEX_NAME,
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates,
          limit: k,
        },
      },
      {
        $project: {
          text: 1,
          source: 1,
          chunkId: 1,
          metadata: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ])
    .toArray()) as AtlasVectorChunk[];

  const results = storedChunks
    .map((chunk) => {
      const score =
        typeof chunk.score === "number"
          ? atlasVectorSearchScoreToCosine(chunk.score)
          : 0;
      const doc = chunkToDocument(chunk);

      return [doc, score] as ScoredChunk;
    })
    .filter(([doc]) => doc.pageContent.trim().length > 0);

  return buildResult(results);
}

export async function retrieveRelevantChunks(
  query: string,
  k: number = 5
): Promise<RetrieverResult> {
  if (!query.trim()) {
    return {
      docs: [],
      confidence: 0,
    };
  }

  const queryEmbedding = await embeddings.embedQuery(query);

  if (env.RETRIEVAL_BACKEND === "app_cosine") {
    return retrieveWithAppCosine(queryEmbedding, k);
  }

  if (isAtlasVectorSearchTemporarilyDisabled()) {
    return retrieveWithAppCosine(queryEmbedding, k);
  }

  try {
    return await retrieveWithAtlasVectorSearch(queryEmbedding, k);
  } catch (error) {
    if (!isVectorSearchConfigurationError(error)) {
      throw error;
    }

    disableAtlasVectorSearchTemporarily();
    console.warn(
      `[retriever] Atlas Vector Search is unavailable or misconfigured; falling back to app_cosine for ${VECTOR_SEARCH_FALLBACK_TTL_MS / 1000}s. ${error instanceof Error ? error.message : String(error)}`
    );
    return retrieveWithAppCosine(queryEmbedding, k);
  }
}
