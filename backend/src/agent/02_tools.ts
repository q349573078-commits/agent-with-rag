// simple functions that agent is going to call
// kb_search
// input -> {query : string}
// contexts

import { z } from "zod";
import { tool } from "langchain";
import { retrieveRelevantChunks } from "../kb/05_retriever";

export const kbSearchTool = tool(
  async ({ question }: { question: string }) => {
    const { docs, confidence } = await retrieveRelevantChunks(question, 2);

    // Extract unique sources and their previews
    const sourceMap = new Map<string, string>();

    docs.forEach((doc) => {
      const source = (doc?.metadata?.source as string) || "unknown_source";

      // Only keep the first preview for each source (deduplication)
      if (!sourceMap.has(source)) {
        const preview =
          doc.pageContent.length > 400
            ? doc.pageContent.slice(0, 400) + "..."
            : doc.pageContent;
        sourceMap.set(source, preview);
      }
    });

    // Convert map to array of contexts
    const contexts = Array.from(sourceMap.entries()).map(([source, preview]) => ({
      source,
      preview,
    }));

    return {
      confidence,
      contexts,
    };
  },
  {
    name: "kb_search",
    description: "Search the documentation KB for relevant answers",
    schema: z.object({
      question: z
        .string()
        .describe(
          `User's question or follow up that must be answered from docs`
        ),
    }),
  }
);

export const agentTools = [kbSearchTool]; // multiple tools also
