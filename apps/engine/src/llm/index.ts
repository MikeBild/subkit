// LLM module barrel — context enhancement, provider routing, and the
// five flows (generate, extract, repair, converse, discover). Tests go
// through the mock provider under `LLM_PROVIDER=mock`; real calls flow
// through `core/invoke.ts` → `AiSdkModel` → Vercel AI SDK, either via
// the AI Gateway or direct provider clients depending on env.

// LLM module barrel.
//
// Convention: `export *` is used for files whose entire export surface
// is intentionally public (each function in those files passes through
// review). Files where only specific symbols should be public use a
// pinned named-export list. The narrow flows export only the entry
// point function (`runConverseFlow`, `runExtractFlow`, etc.) — the
// internal helpers in those files stay internal even though they are
// `export`ed at the file level (TypeScript surface hygiene; routes
// reach in via this barrel only).
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
export * from "./provider-errors.ts";
export * from "./runtime-context.ts";
export * from "./types.ts";
