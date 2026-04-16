// LLM module barrel — context enhancement, provider routing, and the
// four authoring flows (generate, extract, repair, converse). Tests go
// through the mock provider under `LLM_PROVIDER=mock`; production wires
// through the Anthropic SDK from `provider.ts`.

export * from "./budgets.ts";
export * from "./context.ts";
export * from "./errors.ts";
export { runConverseFlow } from "./flows/converse.ts";
export { runExtractFlow } from "./flows/extract.ts";
export { runGenerateFlow } from "./flows/generate.ts";
export type { PatchProposal } from "./flows/repair.ts";
export { PatchProposalSchema, runRepairFlow } from "./flows/repair.ts";
export { getMockProvider, resetMockProvider } from "./mock-provider.ts";
export { callWithFallback, resolveModelRoute } from "./provider.ts";
export * from "./tokens.ts";
export * from "./types.ts";
