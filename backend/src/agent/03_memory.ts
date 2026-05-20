import type { Collection, WithId } from "mongodb";
import { getDb } from "../utils/mongo";
import { nanoid } from "nanoid";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  ts?: Date;
}

export interface ConversationDoc {
  threadId: string;
  messages: {
    role: ChatRole;
    content: string;
    ts?: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const CONVERSATIONS_COLLECTION = "conversations";

let convCollectionPromise: Promise<Collection<ConversationDoc>> | null = null;
let useInMemoryHistory = false;
const memoryConversations = new Map<string, ConversationDoc>();

function getMemoryConversation(threadId: string): ConversationDoc | null {
  return memoryConversations.get(threadId) ?? null;
}

function upsertMemoryConversation(doc: ConversationDoc) {
  memoryConversations.set(doc.threadId, doc);
}

function createEmptyConversation(threadId: string): ConversationDoc {
  const now = new Date();
  return {
    threadId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function getConversationsCollection(): Promise<
  Collection<ConversationDoc>
> {
  if (useInMemoryHistory) {
    throw new Error("Conversation history is using in-memory fallback");
  }

  if (!convCollectionPromise) {
    convCollectionPromise = (async () => {
      try {
        const db = await getDb();
        const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);

        await col.createIndex({ threadId: 1 }, { unique: true });

        return col;
      } catch (error) {
        useInMemoryHistory = true;
        convCollectionPromise = null;
        console.warn(
          "[memory] Falling back to in-memory conversation history:",
          error
        );
        throw error;
      }
    })();
  }

  return convCollectionPromise;
}

export async function ensureThreadId(
  isThreadIdPresent?: string
): Promise<string> {
  if (useInMemoryHistory) {
    if (isThreadIdPresent && getMemoryConversation(isThreadIdPresent)) {
      return isThreadIdPresent;
    }

    const threadId = nanoid(12);
    upsertMemoryConversation(createEmptyConversation(threadId));
    return threadId;
  }

  let col: Collection<ConversationDoc>;
  try {
    col = await getConversationsCollection();
  } catch {
    return ensureThreadId(isThreadIdPresent);
  }

  if (isThreadIdPresent) {
    const existing = await col.findOne({ threadId: isThreadIdPresent });

    if (existing) return isThreadIdPresent;
  }

  const threadId = nanoid(12);

  const now = new Date();

  await col.insertOne({
    threadId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  });

  return threadId;
}

export async function getHistory(threadId: string): Promise<ChatMessage[]> {
  if (useInMemoryHistory) {
    const conv = getMemoryConversation(threadId);
    if (!conv) return [];

    return conv.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      ts: msg.ts,
    }));
  }

  let col: Collection<ConversationDoc>;
  try {
    col = await getConversationsCollection();
  } catch {
    return getHistory(threadId);
  }
  const conv: WithId<ConversationDoc> | null = await col.findOne({ threadId });

  if (!conv) return [];

  return conv.messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    ts: msg.ts,
  }));
}

export async function appendToHistory(
  threadId: string,
  ...messages: ChatMessage[]
): Promise<void> {
  if (!messages.length) return;

  const messagesWithTs = messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    ts: msg.ts ?? new Date(),
  }));

  if (useInMemoryHistory) {
    const existing = getMemoryConversation(threadId) ?? createEmptyConversation(threadId);
    upsertMemoryConversation({
      ...existing,
      messages: [...existing.messages, ...messagesWithTs],
      updatedAt: new Date(),
    });
    return;
  }

  let col: Collection<ConversationDoc>;
  try {
    col = await getConversationsCollection();
  } catch {
    await appendToHistory(threadId, ...messages);
    return;
  }

  await col.updateOne(
    { threadId },
    {
      $push: {
        messages: {
          $each: messagesWithTs,
        },
      },
      $set: {
        updatedAt: new Date(),
      },
    }
  );
}
