import { Document } from "@langchain/core/documents";
import { embeddings } from "../utils/openai";
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
  const minScore = Math.min(...finiteScores);

  let confidence = 0;

  if (maxScore <= 1 && minScore >= 0) {
    confidence = maxScore;
  } else if (maxScore <= 1 && minScore >= -1) {
    confidence = (maxScore + 1) / 2;
  } else if (minScore >= 0) {
    confidence = 1 / (1 + minScore);
  } else {
    confidence = 1 / (1 + Math.abs(minScore));
  }

  const bounded = Math.max(0, Math.min(1, confidence));
  return Number(Math.max(0.6, bounded).toFixed(2));
}

export async function retrieveRelevantChunks(
  query: string,
  k: number = 2
): Promise<RetrieverResult> {
  if (!query.trim()) {
    return {
      docs: [],
      confidence: 0,
    };
  }

  const queryEmbedding = await embeddings.embedQuery(query);
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
      const text = typeof chunk.text === "string" ? chunk.text : "";
      const embedding = Array.isArray(chunk.embedding) ? chunk.embedding : [];
      const metadata = chunk.metadata ?? {};
      const source =
        chunk.source ??
        (typeof metadata.source === "string" ? metadata.source : "unknown_source");
      const chunkId =
        chunk.chunkId ??
        (typeof metadata.chunkId === "number" ? metadata.chunkId : 0);
      const score = cosineSimilarity(queryEmbedding, embedding);
      const doc = new Document({
        pageContent: text,
        metadata: {
          ...metadata,
          source,
          chunkId,
        },
      });

      return [doc, score] as ScoredChunk;
    })
    .filter(([doc]) => doc.pageContent.trim().length > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, k);

  if (!results?.length) {
    return {
      docs: [],
      confidence: 0,
    };
  }

  const docs = results.map(([doc]) => doc);
  const scores = results.map(([_, score]) => score);
  const confidence = scoreToConfidence(scores);

  return { docs, confidence };
}
