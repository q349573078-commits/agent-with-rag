// LEGO -> 1 -> 2 -> 3 -> 4 -> 5
// RAG pipeline mental model ->
// 1 -> read pdf/md/txt into document[]
// 2 -> split -> break larger docs into smaller and meaningful chunks -> ABCDE -> chunk0 -> ABC -> chunk1 BCD
// 3 -> Embed -> map each and every chunk -> vector (via our openai embedding model)
// 4 -> store -> save vectors + metadata -> vector DB (mongo atlas)
// 5 -> retrive -> for every query that user will ask , fetch relevant chunks by similarity
// 6 -> generate -> LLM answers using only retrived chunks based on context

import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";

// type SupportedMime = "application/pdf" | "text/markdown" | "text/plain";

interface LoadFileArgs {
  filePath: string;
  mimeType: string;
  originalName: string;
}

// sangam.pdf, test.md

function getExt(name: string): string {
  const index = name.lastIndexOf(".");

  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

export async function loadFileAsDocuments(
  args: LoadFileArgs
): Promise<Document[]> {
  const { mimeType, filePath, originalName } = args;

  // Filename is already decoded in the route
  const decodedOriginalName = originalName;

  const extractExt = getExt(decodedOriginalName);

  // pdf, txt, md

  const isMarkdown =
    mimeType === "text/markdown" ||
    extractExt === "md" ||
    extractExt === "markdown";

  const isText = mimeType === "text/plain" || extractExt === "txt";

  const isPdf = mimeType === "application/pdf" || extractExt === "pdf";

  if (isPdf) {
    const loader = new PDFLoader(filePath);
    const docs = await loader.load();

    return docs.map((doc) => ({
      ...doc,
      metadata: {
        ...doc.metadata,
        source: decodedOriginalName, // sources/citations
      },
    }));
  }

  if (isText || isMarkdown) {
    const loader = new TextLoader(filePath);
    const docs = await loader.load();
    return docs.map((doc) => ({
      ...doc,
      metadata: {
        ...doc.metadata,
        source: decodedOriginalName,
      },
    }));
  }

  return [];
}
