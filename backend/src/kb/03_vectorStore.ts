import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { Collection as MongoCollection } from "mongodb";
import { getDb, isMongoConnectionError } from "../utils/mongo";
import { embeddings } from "../utils/openai";
import { env } from "../utils/env";
import { getLocalKbCollection } from "./localStore";

const KB_COLLECTION_NAME = "kb_chunks";
const KB_FILES_COLLECTION_NAME = "kb_files";

let collectionPromise: Promise<MongoCollection> | null = null;
let filesCollectionPromise: Promise<MongoCollection> | null = null;
let vectorStorePromise: Promise<MongoDBAtlasVectorSearch> | null = null;

async function getMongoCollectionOrLocal(
  mongoCollectionName: string,
  localCollectionName: "kb_chunks" | "kb_files"
): Promise<MongoCollection> {
  try {
    const db = await getDb();
    return db.collection(mongoCollectionName);
  } catch (error) {
    if (!isMongoConnectionError(error)) {
      throw error;
    }

    console.warn(
      `[kb] MongoDB is unavailable; using local file store for ${localCollectionName}. ${error instanceof Error ? error.message : String(error)}`
    );
    return getLocalKbCollection(localCollectionName) as any;
  }
}

export async function getKbCollection(): Promise<MongoCollection> {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      return getMongoCollectionOrLocal(KB_COLLECTION_NAME, "kb_chunks");
    })().catch((error) => {
      collectionPromise = null;
      throw error;
    });
  }

  return collectionPromise;
}

export async function getKbFilesCollection(): Promise<MongoCollection> {
  if (!filesCollectionPromise) {
    filesCollectionPromise = (async () => {
      const collection = await getMongoCollectionOrLocal(
        KB_FILES_COLLECTION_NAME,
        "kb_files"
      );

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
    })().catch((error) => {
      filesCollectionPromise = null;
      throw error;
    });
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
    })().catch((error) => {
      vectorStorePromise = null;
      throw error;
    });
  }

  return vectorStorePromise;
}
