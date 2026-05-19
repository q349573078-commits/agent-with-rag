import { Db, MongoClient } from "mongodb";
import { resolve4, resolve6, resolveSrv } from "dns/promises";
import { env } from "./env";

let client: MongoClient | null = null;
let db: Db | null = null;

export class MongoDnsHijackError extends Error {
  host: string;
  resolvedIps: string[];

  constructor(args: { host: string; resolvedIps: string[]; cause?: unknown }) {
    super(
      `Suspicious DNS resolution for ${args.host}: ${args.resolvedIps.join(", ")}`
    );
    this.name = "MongoDnsHijackError";
    this.host = args.host;
    this.resolvedIps = args.resolvedIps;
    (this as any).cause = args.cause;
  }
}

function extractMongoHostFromUri(uri: string): string | null {
  const srvPrefix = "mongodb+srv://";
  const stdPrefix = "mongodb://";

  let rest = uri;
  if (rest.startsWith(srvPrefix)) rest = rest.slice(srvPrefix.length);
  else if (rest.startsWith(stdPrefix)) rest = rest.slice(stdPrefix.length);
  else return null;

  const atIndex = rest.indexOf("@");
  if (atIndex !== -1) rest = rest.slice(atIndex + 1);

  const endIndexCandidates = [
    rest.indexOf("/"),
    rest.indexOf("?"),
    rest.indexOf("#"),
  ].filter((n) => n !== -1);

  const endIndex =
    endIndexCandidates.length > 0 ? Math.min(...endIndexCandidates) : rest.length;

  const hostPortOrHosts = rest.slice(0, endIndex);
  const firstHostPort = hostPortOrHosts.split(",")[0]?.trim();
  if (!firstHostPort) return null;

  const hostOnly = firstHostPort.split(":")[0]?.trim();
  return hostOnly || null;
}

export function getMongoConnectionInfo(): {
  host: string | null;
  dbName: string;
  isSrv: boolean;
  isAtlas: boolean;
} {
  const uri = env.MONGODB_ATLAS_URI;
  const host = extractMongoHostFromUri(uri);
  const isSrv = uri.startsWith("mongodb+srv://");
  const isAtlas = uri.includes("mongodb.net");

  return {
    host,
    dbName: env.MONGODB_DB_NAME,
    isSrv,
    isAtlas,
  };
}

function isReservedIpv4ForTesting(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;

  return a === 198 && (b === 18 || b === 19);
}

async function detectSuspiciousAtlasDns(uri: string): Promise<{
  host: string;
  resolvedIps: string[];
  suspicious: boolean;
} | null> {
  const host = extractMongoHostFromUri(uri);
  if (!host) return null;

  try {
    const srvRecords = await resolveSrv(`_mongodb._tcp.${host}`);
    const targets = srvRecords.map((r) => r.name);
    const ipLists = await Promise.all(
      targets.map(async (target) => {
        const [v4, v6] = await Promise.allSettled([
          resolve4(target),
          resolve6(target),
        ]);
        const ips: string[] = [];
        if (v4.status === "fulfilled") ips.push(...v4.value);
        if (v6.status === "fulfilled") ips.push(...v6.value);
        return ips;
      })
    );

    const resolvedIps = Array.from(new Set(ipLists.flat()));
    const suspicious = resolvedIps.some((ip) => isReservedIpv4ForTesting(ip));

    return { host, resolvedIps, suspicious };
  } catch {
    return { host, resolvedIps: [], suspicious: false };
  }
}

export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;

  const uri = env.MONGODB_ATLAS_URI;

  if (uri.includes("mongodb.net") && !uri.startsWith("mongodb+srv://")) {
    console.warn(
      "[mongo] Atlas detected but URI is not mongodb+srv://. Prefer mongodb+srv:// from Atlas for correct TLS/DNS settings."
    );
  }

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 20_000,
    retryReads: true,
    retryWrites: true,
  });

  try {
    await client.connect();
  } catch (error) {
    const dnsCheck = await detectSuspiciousAtlasDns(uri);
    if (dnsCheck?.suspicious) {
      throw new MongoDnsHijackError({
        host: dnsCheck.host,
        resolvedIps: dnsCheck.resolvedIps,
        cause: error,
      });
    }

    console.error("[mongo] Failed to connect to MongoDB", error);
    throw error;
  }

  console.log("Connected to mongodb");

  return client;
}

export async function getDb(): Promise<Db> {
  if (db) return db;

  const extractMongoClient = await getMongoClient();

  db = extractMongoClient.db(env.MONGODB_DB_NAME);

  console.log(`Using current mongodb DB -> ${env.MONGODB_DB_NAME}`);

  return db;
}
