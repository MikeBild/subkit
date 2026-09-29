// LLM module barrel — context enhancement, provider routing, and the
// five flows (generate, extract, repair, converse, discover). Tests go
// through the mock provider under `LLM_PROVIDER=mock`; real calls flow
// through `core/invoke.ts` → `AiSdkModel` → Vercel AI SDK, either via
// the AI Gateway or direct provider clients depending on env.

// LLM module barrel.
//
// Convention: `export *` is used for files whose entire file-level
// export surface is intentionally public — each `export` in those
// files passes through review. Internal helpers stay as non-exported
// functions, so the barrel reflects exactly the file's intended
// surface. The flow modules (`flows/converse.ts`, `flows/extract.ts`,
// etc.) use a pinned named-export list because those files contain
// internal helpers that ARE `export`ed at the file level (legacy)
// but should not flow through the barrel.
export * from "./accounting/index.ts";
export * from "./core/context-assembler.ts";
export * from "./core/invoke.ts";
export * from "./core/model-init.ts";
export * from "./errors.ts";
export { runConverseFlow } from "./flows/converse.ts";
export type { DiscoverArtifact, DiscoverEnvelope } from "./flows/discover.ts";
export { DiscoverArtifactSchema, runDiscoverFlow } from "./flows/discover.ts";
export { runExtractFlow } from "./flows/extract.ts";
export { runGenerateFlow } from "./flows/generate.ts";
export type { PatchProposal } from "./flows/repair.ts";
export { PatchProposalSchema, runRepairFlow } from "./flows/repair.ts";
export { runSummarizeFlow } from "./flows/summarize.ts";
export { getMockProvider, resetMockProvider } from "./mock-provider.ts";
// Read-time money. Routes reach pricing through this entry point, never the
// module: the layering invariant exists so a subsystem can move its files
// without breaking every caller, and a route that imports an internal is the
// first step to a route that imports three.
export {
  type CatalogModelPrice,
  effectiveModelPrices,
  MODEL_PRICE_CATALOG,
  MODEL_PRICE_CATALOG_CURRENCY,
} from "./model-price-catalog.ts";
export {
  type CostResult,
  type LongContextPrice,
  longContextThresholds,
  type ModelPrice,
  PRICE_SOURCES,
  type PricedTokens,
  type PriceSource,
  priceCalls,
  type SourcedModelPrice,
} from "./pricing.ts";
export * from "./provider-errors.ts";
export * from "./runtime-context.ts";
export * from "./types.ts";
