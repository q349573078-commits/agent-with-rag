// chunking -> bridge between raw Docs and useful RAG
// keeping chunks very big -> retriver
// keeping chunks very small ->
// small but at the same long enough

import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// ABCDE -> ABC, BCD, CDE, DE

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP_SIZE = 150;

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: DEFAULT_CHUNK_SIZE,
  chunkOverlap: DEFAULT_CHUNK_OVERLAP_SIZE,
});

export async function splitDocuments(docs: Document[]): Promise<Document[]> {
  if (!docs.length) return [];

  const chunks = await splitter.splitDocuments(docs);

  return chunks.map((chunk, index) => {
    const base = chunk?.metadata ?? {};

    return new Document({
      pageContent: chunk.pageContent.trim(),
      metadata: {
        ...base,
        source: base?.source ?? "unknown_source",
        _chunkIndex: index,
      },
    });
  });
}
