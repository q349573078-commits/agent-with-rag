import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";

interface LoadFileArgs {
  filePath: string;
  mimeType: string;
  originalName: string;
}

function getExt(name: string): string {
  const index = name.lastIndexOf(".");

  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

export async function loadFileAsDocuments(
  args: LoadFileArgs
): Promise<Document[]> {
  const { mimeType, filePath, originalName } = args;

  const decodedOriginalName = originalName;

  const extractExt = getExt(decodedOriginalName);

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
        source: decodedOriginalName,
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
