import { Document } from "@langchain/core/documents";
import { readFile } from "fs/promises";
import pdfParse from "pdf-parse";

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
    const buffer = await readFile(filePath);
    const result = await pdfParse(buffer);

    const text = typeof result.text === "string" ? result.text.trim() : "";
    return text
      ? [
        new Document({
          pageContent: text,
          metadata: {
            source: decodedOriginalName,
            totalPages: result.numpages,
          },
        }),
      ]
      : [];
  }

  if (isText || isMarkdown) {
    const text = await readFile(filePath, "utf8");
    const trimmedText = text.trim();
    return trimmedText
      ? [
        new Document({
          pageContent: trimmedText,
          metadata: {
            source: decodedOriginalName,
          },
        }),
      ]
      : [];
  }

  return [];
}
