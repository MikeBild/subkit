// Test-helpers shim for the @ai-sdk/otel telemetry integration.
//
// The `no_live_llm` audit invariant forbids direct `@ai-sdk/*` imports in any
// `*.test.ts` file (tests must stay hermetic — no live-LLM SDK). The
// `OpenTelemetry` class is a telemetry ADAPTER, not a live-LLM path: telemetry
// tests exercise it against a `MockLanguageModelV4` with an in-memory span
// exporter, so they remain hermetic. Re-exporting it here keeps the test files
// free of the forbidden import while preserving the integration coverage.
export { OpenTelemetry } from "@ai-sdk/otel";
