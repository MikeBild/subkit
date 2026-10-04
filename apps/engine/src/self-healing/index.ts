export { PatchProposalSchema } from "../llm/flows/repair.ts";
export {
  approvePatchCandidate,
  PatchDecisionError,
  rejectPatchCandidate,
} from "./candidate-decision.ts";
export {
  PatchReadinessSchema,
  readPatchReadiness,
  readPatchReadinessBatch,
} from "./candidate-readiness.ts";
export * from "./candidate-review.ts";
export type { RateLimitPatchCandidate } from "./classifier.ts";
export { classifyPatch, classifyRateLimitFromTemplate } from "./classifier.ts";
export type { FailingStepSnapshot } from "./drift-detector.ts";
export { analyzeStepFailure, renderDriftDiff } from "./drift-detector.ts";
export { applyPatchToStep, runFixtureDryRun } from "./fixture-runner.ts";
export type { GateRepairOutcome } from "./gate-repairs.ts";
export { GateRepairError, proposeGateRepair, proposeGateRepairs } from "./gate-repairs.ts";
export type { OpenPatchDecision, OpenPatchDecisions } from "./open-decisions.ts";
export {
  closeIfUndecidable,
  closeUndecidableCandidate,
  readOpenPatchDecisions,
  sweepUndecidableCandidates,
  UNDECIDABLE_REASONS,
} from "./open-decisions.ts";
export type {
  PatchApplyFailure,
  PatchApplyOutcome,
  PathRewrite,
  ProjectionSlots,
} from "./patch-apply.ts";
export {
  applyPatchToWorkflowDag,
  applyRewriteToSlots,
  diffStepPaths,
  resolvePathRewrite,
} from "./patch-apply.ts";
export type { AutohealPolicy } from "./policy.ts";
export {
  DEFAULT_AUTOHEAL_POLICY,
  resolvePolicy,
  shouldAutoApply,
} from "./policy.ts";
export { preparePatchCandidate } from "./prepare-candidate.ts";
export type {
  ProactiveScanFilters,
  ScannedSignal,
  ScannedSignalContext,
  ScanResult,
  UnanchoredDrift,
} from "./proactive-scanner.ts";
export { driftSignalContext, scanForDrift } from "./proactive-scanner.ts";
export type {
  ProcessSignalOptions,
  ProcessSignalResult,
  RunSelfHealingParams,
  SelfHealingResult,
  SignalContext,
  SignalSource,
} from "./service.ts";
export * from "./service.ts";
export { processDriftSignal, runSelfHealingLoop } from "./service.ts";
export { scanStdlibDrift } from "./stdlib-drift-scan.ts";
export { buildDryRunStep, loadStepSnapshot, loadWorkflowStepKey } from "./step-snapshot.ts";
export type {
  DriftSignal,
  DryRunFixture,
  DryRunResult,
  DryRunStep,
  PatchDecision,
  SchemaShape,
  WorkflowRepairJob,
} from "./types.ts";
