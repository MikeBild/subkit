// Public API barrel for the `execution` subsystem. Routes and other
// subsystems must import from this entry point only — see the
// route_layering check at apps/engine/scripts/audit-invariants.ts.
//
// `export *` discipline: each file in this barrel keeps internal
// helpers (e.g. `runCallStep` in `engine.ts`) as NON-exported
// functions, so `export *` widens the barrel to exactly the file's
// intentional public surface. Adding a new top-level `export` to any
// file in this list is a deliberate API decision; treat it like
// adding a new entry here.

export * from "./abort.ts";
export * from "./admission-audit.ts";
export {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "./authority-admission.ts";
export { PREVIEW_CLASSIFICATIONS, type PreviewClassification } from "./classify.ts";
export * from "./engine.ts";
export * from "./jsonata-engine.ts";
export * from "./list.ts";
export * from "./outcome.ts";
export * from "./request-meta-schema.ts";
export * from "./resolve-definition.ts";
export * from "./response-filter.ts";
export * from "./state.ts";
export * from "./types.ts";
export { admitWorkflowRun } from "./workflow-run-admission.ts";
