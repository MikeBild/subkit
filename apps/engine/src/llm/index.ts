// LLM module barrel — context enhancement, provider routing, and the
// five flows (generate, extract, repair, converse, discover). Tests go
// through the mock provider under `LLM_PROVIDER=mock`; real calls flow
// through `core/invoke.ts` → `AiSdkModel` → Vercel AI SDK, either via
// the AI Gateway or direct provider clients depending on env.

export * from "./accounting/index.ts";
export * from "./core/context-assembler.ts";
export * from "./core/invoke.ts";
export * from "./core/model-init.ts";
export * from "./errors.ts";
// `flows/converse.ts` is intentionally narrow — only `runConverseFlow`
// is part of the public API. Other helpers in that file are internal.
export { runConverseFlow } from "./flows/converse.ts";
export * from "./flows/discover.ts";
export * from "./flows/extract.ts";
export * from "./flows/generate.ts";
export * from "./flows/repair.ts";
export * from "./flows/summarize.ts";
export { getMockProvider, resetMockProvider } from "./mock-provider.ts";
export * from "./runtime-context.ts";
export * from "./types.ts";
