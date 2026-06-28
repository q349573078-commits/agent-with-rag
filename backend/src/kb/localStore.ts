import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { ObjectId } from "mongodb";

type StoredDoc = Record<string, any>;
type StoredData = {
  kb_chunks: StoredDoc[];
  kb_files: StoredDoc[];
};
type SortSpec = Record<string, 1 | -1>;
type ProjectionSpec = Record<string, 0 | 1>;

const LOCAL_STORE_PATH = join(process.cwd(), "data", "kb-local-store.json");
const EMPTY_DATA: StoredData = {
  kb_chunks: [],
  kb_files: [],
};

let dataPromise: Promise<StoredData> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function cloneValue<T>(value: T): T {
  if (value instanceof ObjectId) {
    return new ObjectId(value.toHexString()) as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)])
    ) as T;
  }
  return value;
}

function cloneDoc<T>(doc: T): T {
  return cloneValue(doc);
}

function objectIdToString(value: unknown): string | null {
  if (value instanceof ObjectId) return value.toHexString();
  if (value && typeof (value as any).toHexString === "function") {
    return (value as any).toHexString();
  }
  return typeof value === "string" ? value : null;
}

function normalizeDocForMemory(doc: StoredDoc): StoredDoc {
  const next = { ...doc };
  const id = objectIdToString(next._id);
  if (id && ObjectId.isValid(id)) {
    next._id = new ObjectId(id);
  }
  if (typeof next.uploadedAt === "string") {
    next.uploadedAt = new Date(next.uploadedAt);
  }
  return next;
}

function normalizeDocForDisk(doc: StoredDoc): StoredDoc {
  const next = cloneDoc(doc);
  const id = objectIdToString(next._id);
  if (id) next._id = id;
  return next;
}

async function loadData(): Promise<StoredData> {
  if (!dataPromise) {
    dataPromise = (async () => {
      try {
        const raw = await readFile(LOCAL_STORE_PATH, "utf8");
        const parsed = JSON.parse(raw) as Partial<StoredData>;
        return {
          kb_chunks: Array.isArray(parsed.kb_chunks)
            ? parsed.kb_chunks.map(normalizeDocForMemory)
            : [],
          kb_files: Array.isArray(parsed.kb_files)
            ? parsed.kb_files.map(normalizeDocForMemory)
            : [],
        };
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          return cloneDoc(EMPTY_DATA);
        }
        throw error;
      }
    })();
  }

  return dataPromise;
}

async function persistData(data: StoredData): Promise<void> {
  const write = async () => {
    await mkdir(dirname(LOCAL_STORE_PATH), { recursive: true });
    const diskData: StoredData = {
      kb_chunks: data.kb_chunks.map(normalizeDocForDisk),
      kb_files: data.kb_files.map(normalizeDocForDisk),
    };
    await writeFile(LOCAL_STORE_PATH, JSON.stringify(diskData, null, 2));
  };

  writeQueue = writeQueue.then(write, write);
  return writeQueue;
}

function getPathValue(doc: StoredDoc, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object") {
      return (value as any)[key];
    }
    return undefined;
  }, doc);
}

function setPathValue(doc: StoredDoc, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = doc;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  const leftId = objectIdToString(left);
  const rightId = objectIdToString(right);
  if (leftId || rightId) return leftId === rightId;
  return left === right;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "date") return value instanceof Date;
  if (type === "object") {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }
  return false;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (
    condition &&
    typeof condition === "object" &&
    !(condition instanceof Date) &&
    !(condition instanceof ObjectId) &&
    !Array.isArray(condition)
  ) {
    for (const [operator, expected] of Object.entries(condition)) {
      if (operator === "$type") {
        if (!matchesType(value, String(expected))) return false;
      } else if (operator === "$exists") {
        if ((value !== undefined) !== Boolean(expected)) return false;
      } else if (operator === "$ne") {
        if (valuesEqual(value, expected)) return false;
      } else {
        return false;
      }
    }
    return true;
  }

  return valuesEqual(value, condition);
}

function matchesFilter(doc: StoredDoc, filter: StoredDoc = {}): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or") {
      if (
        !Array.isArray(condition) ||
        !condition.some((item) => matchesFilter(doc, item))
      ) {
        return false;
      }
      continue;
    }

    if (!matchesCondition(getPathValue(doc, key), condition)) {
      return false;
    }
  }
  return true;
}

function applyProjection(doc: StoredDoc, projection?: ProjectionSpec): StoredDoc {
  if (!projection) return cloneDoc(doc);

  const includeKeys = Object.entries(projection)
    .filter(([_, value]) => value === 1)
    .map(([key]) => key);
  if (includeKeys.length > 0) {
    const next: StoredDoc = {};
    for (const key of includeKeys) {
      const value = getPathValue(doc, key);
      if (value !== undefined) setPathValue(next, key, value);
    }
    if (projection._id !== 0 && doc._id !== undefined) {
      next._id = doc._id;
    }
    return cloneDoc(next);
  }

  const next = cloneDoc(doc);
  for (const [key, value] of Object.entries(projection)) {
    if (value === 0) delete next[key];
  }
  return next;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

class LocalCursor {
  private docsPromise: Promise<StoredDoc[]>;

  constructor(docsPromise: Promise<StoredDoc[]>) {
    this.docsPromise = docsPromise;
  }

  sort(spec: SortSpec): LocalCursor {
    this.docsPromise = this.docsPromise.then((docs) => {
      const entries = Object.entries(spec);
      return [...docs].sort((left, right) => {
        for (const [key, direction] of entries) {
          const leftValue = getPathValue(left, key) as any;
          const rightValue = getPathValue(right, key) as any;
          if (leftValue === rightValue) continue;
          if (leftValue === undefined) return 1;
          if (rightValue === undefined) return -1;
          return leftValue > rightValue ? direction : -direction;
        }
        return 0;
      });
    });
    return this;
  }

  limit(count: number): LocalCursor {
    this.docsPromise = this.docsPromise.then((docs) => docs.slice(0, count));
    return this;
  }

  async toArray(): Promise<StoredDoc[]> {
    return (await this.docsPromise).map(cloneDoc);
  }
}

class LocalDb {
  async command(command: StoredDoc): Promise<StoredDoc> {
    if (command.ping === 1) return { ok: 1, local: true };
    return { ok: 1, local: true };
  }
}

export class LocalKbCollection {
  readonly db = new LocalDb();
  readonly isLocalKbCollection = true;
  private name: keyof StoredData;

  constructor(name: keyof StoredData) {
    this.name = name;
  }

  async createIndex(_keys: StoredDoc, options?: { name?: string }): Promise<string> {
    return options?.name ?? "local_index";
  }

  find(filter: StoredDoc = {}, options?: { projection?: ProjectionSpec }): LocalCursor {
    const docsPromise = loadData().then((data) =>
      data[this.name]
        .filter((doc) => matchesFilter(doc, filter))
        .map((doc) => applyProjection(doc, options?.projection))
    );
    return new LocalCursor(docsPromise);
  }

  async findOne(
    filter: StoredDoc = {},
    options?: { projection?: ProjectionSpec }
  ): Promise<StoredDoc | null> {
    const docs = await this.find(filter, options).limit(1).toArray();
    return docs[0] ?? null;
  }

  async distinct(field: string): Promise<unknown[]> {
    const data = await loadData();
    const values = data[this.name]
      .map((doc) => getPathValue(doc, field))
      .filter((value) => value !== undefined);
    return Array.from(new Set(values));
  }

  async insertOne(doc: StoredDoc): Promise<{ acknowledged: true; insertedId: unknown }> {
    const data = await loadData();
    const next = normalizeDocForMemory({
      ...doc,
      _id: doc._id ?? new ObjectId(),
    });
    data[this.name].push(next);
    await persistData(data);
    return { acknowledged: true, insertedId: next._id };
  }

  async insertMany(
    docs: StoredDoc[]
  ): Promise<{ acknowledged: true; insertedCount: number }> {
    const data = await loadData();
    data[this.name].push(
      ...docs.map((doc) =>
        normalizeDocForMemory({
          ...doc,
          _id: doc._id ?? new ObjectId(),
        })
      )
    );
    await persistData(data);
    return { acknowledged: true, insertedCount: docs.length };
  }

  async updateOne(
    filter: StoredDoc,
    update: { $set?: StoredDoc }
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number }> {
    const data = await loadData();
    const doc = data[this.name].find((item) => matchesFilter(item, filter));
    if (!doc) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    if (update.$set) Object.assign(doc, update.$set);
    await persistData(data);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: StoredDoc): Promise<{ acknowledged: true; deletedCount: number }> {
    const data = await loadData();
    const index = data[this.name].findIndex((doc) => matchesFilter(doc, filter));
    if (index === -1) {
      return { acknowledged: true, deletedCount: 0 };
    }
    data[this.name].splice(index, 1);
    await persistData(data);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter: StoredDoc): Promise<{ acknowledged: true; deletedCount: number }> {
    const data = await loadData();
    const before = data[this.name].length;
    data[this.name] = data[this.name].filter((doc) => !matchesFilter(doc, filter));
    const deletedCount = before - data[this.name].length;
    if (deletedCount > 0) await persistData(data);
    return { acknowledged: true, deletedCount };
  }

  async countDocuments(filter: StoredDoc = {}): Promise<number> {
    const data = await loadData();
    return data[this.name].filter((doc) => matchesFilter(doc, filter)).length;
  }

  aggregate(pipeline: StoredDoc[]): LocalCursor {
    const docsPromise = loadData().then((data) => {
      const vectorSearch = pipeline.find((stage) => stage.$vectorSearch)
        ?.$vectorSearch;
      if (!vectorSearch) return [];

      const queryVector = Array.isArray(vectorSearch.queryVector)
        ? vectorSearch.queryVector
        : [];
      const limit =
        typeof vectorSearch.limit === "number" ? vectorSearch.limit : 5;

      return data[this.name]
        .filter((doc) => typeof doc.text === "string" && Array.isArray(doc.embedding))
        .map((doc) => {
          const score = cosineSimilarity(queryVector, doc.embedding);
          return {
            ...doc,
            score: (Math.max(-1, Math.min(1, score)) + 1) / 2,
          };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((doc) => {
          const project = pipeline.find((stage) => stage.$project)?.$project;
          return applyProjection(doc, project);
        });
    });
    return new LocalCursor(docsPromise);
  }
}

const localCollections = {
  kb_chunks: new LocalKbCollection("kb_chunks"),
  kb_files: new LocalKbCollection("kb_files"),
};

export function getLocalKbCollection(name: keyof StoredData): LocalKbCollection {
  return localCollections[name];
}

export function isLocalKbCollection(collection: unknown): boolean {
  return !!(
    collection &&
    typeof collection === "object" &&
    (collection as any).isLocalKbCollection
  );
}
