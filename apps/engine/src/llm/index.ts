// LLM module barrel — context enhancement, provider routing, and the
// five flows (generate, extract, repair, converse, discover). Tests go
// through the mock provider under `LLM_PROVIDER=mock`; real calls flow
// through `core/invoke.ts` → `AiSdkModel` → Vercel AI SDK, either via
// the AI Gateway or direct provider clients depending on env.

export * from "./accounting/index.ts";
export * from "./core/context-assembler.ts";
export { invoke, resolveModelRoute } from "./core/invoke.ts";
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
export * from "./types.ts";
