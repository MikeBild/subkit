export { backfillEmbeddings } from "./backfill.ts";
export {
  cosineSimilarity,
  EMBEDDING_MODEL,
  embeddingsAvailable,
  embedTexts,
} from "./local-provider.ts";
export { fuseVectorFirst, vectorScoreCandidates } from "./vector-rerank.ts";
