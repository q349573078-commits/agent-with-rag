import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z
    .string()
    .default("5000")
    .transform((val) => Number(val)),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  TAVILY_API_KEY: z.string().optional(),
  MONGODB_ATLAS_URI: z.string().min(1, "MONGODB_ATLAS_URI is required"),
  MONGODB_DB_NAME: z.string().min(1, "MONGODB_DB_NAME is required"),
  RERANK_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase())
    .transform((value) => value === "true" || value === "1" || value === "yes"),
  RERANK_CANDIDATES: z
    .string()
    .default("20")
    .transform((val) => Number(val))
    .pipe(z.number().int().min(4).max(50)),
  RERANK_TOP_K: z
    .string()
    .default("4")
    .transform((val) => Number(val))
    .pipe(z.number().int().min(1).max(10)),
  RETRIEVAL_MIN_SCORE: z
    .string()
    .default("0.5")
    .transform((val) => Number(val))
    .pipe(z.number().min(0).max(1)),
  RETRIEVAL_LOW_CONFIDENCE_THRESHOLD: z
    .string()
    .default("0.6")
    .transform((val) => Number(val))
    .pipe(z.number().min(0).max(1)),
  RETRIEVAL_BACKEND: z
    .enum(["atlas_vector", "app_cosine"])
    .default("atlas_vector"),
  KB_VECTOR_INDEX_NAME: z.string().default("kb_vector_index"),
  VECTOR_SEARCH_NUM_CANDIDATES: z
    .string()
    .default("100")
    .transform((val) => Number(val))
    .pipe(z.number().int().min(1)),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.log("Invalid environment configuration");

  process.exit(1);
}

export const env = Object.freeze(parsed.data);
