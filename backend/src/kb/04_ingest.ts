import { Document } from "@langchain/core/documents";
import { embeddings } from "../utils/openai";
import { getKbCollection } from "./03_vectorStore";

export interface IngestSummary {
  ok: boolean;
  totalChunks: number;
  sources: string[];
}

export async function ingestDocuments(
  chunks: Document[]
): Promise<IngestSummary> {
  if (!chunks.length) {
    return {
      ok: false,
      totalChunks: 0,
      sources: [],
    };
  }

  const collection = await getKbCollection();
  let currentId = 0;
  const texts = chunks.map((chunk) => chunk.pageContent);
  const chunkEmbeddings = await embeddings.embedDocuments(texts);

  const docsWithMeta = chunks.map((chunk, index) => {
    const source = (chunk?.metadata?.source as string) || "unknown_source";
    const chunkId = currentId++;

    return {
      text: chunk.pageContent,
      embedding: chunkEmbeddings[index],
      source,
      chunkId,
      metadata: {
        ...(chunk.metadata ?? {}),
        source,
        chunkId,
      },
    };
  });

  await collection.insertMany(docsWithMeta);

  const sources = Array.from(
    new Set(docsWithMeta.map((doc) => doc.source))
  );

  return {
    ok: true,
    totalChunks: docsWithMeta.length,
    sources,
  };
}
