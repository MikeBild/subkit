// Self-healing: drift detection, schema diff, bounded LLM repair,
// fixture dry-run gate, and safe-patches-only auto-apply policy.
// Implemented in P9 — the full loop lives in `service.ts`.

export type { RateLimitPatchCandidate } from "./classifier.ts";
export { classifyPatch, classifyRateLimitFromTemplate } from "./classifier.ts";
export type { FailingStepSnapshot } from "./drift-detector.ts";
export { analyzeStepFailure, renderDriftDiff } from "./drift-detector.ts";
export { applyPatchToStep, runFixtureDryRun } from "./fixture-runner.ts";
export type {
  AnalyzerConfig,
  AnalyzerRunSample,
  OptimizationCandidate,
  OptimizationKind,
} from "./optimization-analyzer.ts";
export { analyzeRuns } from "./optimization-analyzer.ts";
export type { AutohealPolicy } from "./policy.ts";
export {
  DEFAULT_AUTOHEAL_POLICY,
  resolvePolicy,
  shouldAutoApply,
} from "./policy.ts";
export type { RunSelfHealingParams, SelfHealingResult } from "./service.ts";
export * from "./service.ts";
export {
  approvePatchCandidate,
  rejectPatchCandidate,
  runSelfHealingLoop,
} from "./service.ts";
export type {
  DriftSignal,
  DryRunFixture,
  DryRunResult,
  DryRunStep,
  PatchDecision,
  SchemaShape,
  WorkflowRepairJob,
} from "./types.ts";
