import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { Collection as MongoCollection } from "mongodb";
import { getDb } from "../utils/mongo";
import { embeddings } from "../utils/openai";
import { env } from "../utils/env";

const KB_COLLECTION_NAME = "kb_chunks";
const KB_FILES_COLLECTION_NAME = "kb_files";

let collectionPromise: Promise<MongoCollection> | null = null;
let filesCollectionPromise: Promise<MongoCollection> | null = null;
let vectorStorePromise: Promise<MongoDBAtlasVectorSearch> | null = null;

export async function getKbCollection(): Promise<MongoCollection> {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const db = await getDb();
      return db.collection(KB_COLLECTION_NAME);
    })();
  }

  return collectionPromise;
}

export async function getKbFilesCollection(): Promise<MongoCollection> {
  if (!filesCollectionPromise) {
    filesCollectionPromise = (async () => {
      const db = await getDb();
      const collection = db.collection(KB_FILES_COLLECTION_NAME);

      await Promise.all([
        collection.createIndex(
          { sha256: 1 },
          {
            name: "uniq_sha256",
            unique: true,
            partialFilterExpression: {
              sha256: { $exists: true, $type: "string" },
            },
          }
        ),
        collection.createIndex(
          { normalizedName: 1 },
          { name: "idx_normalizedName" }
        ),
        collection.createIndex({ uploadedAt: -1 }, { name: "idx_uploadedAt" }),
      ]);

      return collection;
    })();
  }

  return filesCollectionPromise;
}

export async function getVectorStore(): Promise<MongoDBAtlasVectorSearch> {
  if (!vectorStorePromise) {
    vectorStorePromise = (async () => {
      const collection = await getKbCollection();

      const vectorStore = new MongoDBAtlasVectorSearch(embeddings, {
        collection: collection as any,
        indexName: env.KB_VECTOR_INDEX_NAME,
        textKey: "text",
        embeddingKey: "embedding",
      });

      return vectorStore;
    })();
  }

  return vectorStorePromise;
}
