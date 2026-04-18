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

async function getConversationsCollection(): Promise<
  Collection<ConversationDoc>
> {
  if (!convCollectionPromise) {
    convCollectionPromise = (async () => {
      const db = await getDb();
      const col = db.collection<ConversationDoc>(CONVERSATIONS_COLLECTION);

      await col.createIndex({ threadId: 1 }, { unique: true });

      return col;
    })();
  }

  return convCollectionPromise;
}

export async function ensureThreadId(
  isThreadIdPresent?: string
): Promise<string> {
  const col = await getConversationsCollection();

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
  const col = await getConversationsCollection();
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

  const col = await getConversationsCollection();

  const messagesWithTs = messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    ts: msg.ts ?? new Date(),
  }));

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
