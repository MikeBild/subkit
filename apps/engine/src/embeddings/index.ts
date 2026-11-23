export { backfillEmbeddings } from "./backfill.ts";
export {
  cosineSimilarity,
  EMBEDDING_MODEL,
  embeddingsAvailable,
  embedTexts,
} from "./local-provider.ts";
export {
  embedQuery,
  type QueryEmbedder,
  VECTOR_MIN_COSINE,
  vectorScoreCandidates,
} from "./vector-rerank.ts";
