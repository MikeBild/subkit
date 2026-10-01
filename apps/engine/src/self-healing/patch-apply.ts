// One patch semantic, three surfaces.
//
// A PatchProposal is — for the only kind the engine can execute — a path
// rewrite: the connector moved a field, so every projection that reads the
// old location must read the new one. That single rewrite has to drive
// three places that must never disagree:
//
//   1. the operator preview (`candidate-review.ts`)  — what the human approves,
//   2. the fixture dry-run gate (`fixture-runner.ts`) — what the engine verifies,
//   3. the apply path (`auto-apply.ts`)               — what the next run executes.
//
// When (3) diverges from (1), "approved" stops meaning anything: the operator
// signs off on a diff that never reaches the workflow. Keeping the semantic in
// one pure function is what makes "what was previewed is what runs" a checkable
// property. `tests/patch-apply.test.ts` is that check.
//
// Everything here is pure — no db, no clock, no io — so the apply path is
// unit-testable without a workflow, and the same function can run inside the
// commit transaction.

import type { PatchProposal } from "../llm/flows/repair.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { applyGateFixOps, GateFixPatchSchema, replanGateFix } from "../workflows/gate-fix.ts";

/**
 * The projection slots a patch may rewrite. Structurally satisfied by both
 * `DryRunStep` (the dry-run/preview shape) and a persisted `request` /
 * `transform` step inside a workflow DAG — which is why the same rewrite can
 * drive preview and apply.
 */
export interface ProjectionSlots {
  data_selector?: string | undefined;
  expression?: string | undefined;
}

export type PatchableStepKind = "request" | "transform";

export interface PathRewrite {
  /** Dotted path the step referenced before the drift. Null when the proposal
   *  only names the new location — then there is nothing to search for and the
   *  rewrite can only introduce a projection, never edit one. */
  from: string | null;
  /** Dotted path the step must reference now. */
  to: string;
}

function toDottedPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const dotted = raw.replace(/^\//, "").replace(/\//g, ".");
  return dotted.length > 0 ? dotted : null;
}

/**
 * Read the executable intent out of a proposal.
 *
 * `update_field_path` is the ONLY kind with executable semantics. The repair
 * flow emits it as `{ op: "replace", path: "/data/id", value: "data/result/id" }`
 * — read as: wherever this step referenced `data.id`, make it reference
 * `data.result.id`.
 *
 * `rename_param`, `add_header` and `change_type` describe changes the engine
 * cannot make to a persisted step definition. They return null here, and the
 * apply path refuses them — a patch the engine cannot perform must not be
 * recorded as applied.
 */
export function resolvePathRewrite(patch: PatchProposal): PathRewrite | null {
  if (patch.kind !== "update_field_path") return null;
  const body = patch.patch as Record<string, unknown>;
  const to = toDottedPath(body.value);
  if (!to) return null;
  return { from: toDottedPath(body.path), to };
}

/**
 * Apply a rewrite to a step's projection slots, returning a copy. The input is
 * never mutated — callers hold persisted rows.
 *
 * The slot depends on the step kind, and mixing them up is how a patch silently
 * corrupts a step: a `data_selector` on a transform step is dead config, and an
 * `expression` on a request step is not read at all.
 */
export function applyRewriteToSlots<T extends ProjectionSlots>(
  slots: T,
  rewrite: PathRewrite,
  kind: PatchableStepKind,
): T {
  const next: T = { ...slots };
  if (kind === "request") {
    if (next.data_selector) {
      // Only a proposal that names the OLD path can edit an existing
      // projection; without it we would have to guess which substring moved.
      if (rewrite.from) {
        next.data_selector = next.data_selector.split(rewrite.from).join(rewrite.to);
      }
    } else {
      // No projection yet — the drifted field IS the projection.
      next.data_selector = rewrite.to;
    }
    return next;
  }
  if (next.expression && rewrite.from) {
    next.expression = next.expression.split(rewrite.from).join(rewrite.to);
  }
  return next;
}

/** Deterministic flat-object diff. Pure — the operator preview and the applied
 *  version report changed paths through this same function. */
export function diffStepPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      changed.push(key);
    }
  }
  return changed;
}

/** Why a patch could not be turned into a new workflow version. Every value is
 *  an honest terminal answer — none of them means "applied". */
export type PatchApplyFailure =
  /** The candidate carries no failing-step anchor, so there is no step to
   *  rewrite. */
  | "no_step_anchor"
  /** The anchor does not resolve to a step in the current version — the
   *  workflow was edited or the step removed since the drift. */
  | "step_not_found"
  /** Only `request` and `transform` steps carry projections. */
  | "unsupported_step_kind"
  /** The proposal kind has no executable semantics (see resolvePathRewrite). */
  | "patch_not_applicable"
  /** The rewrite left the step byte-identical — nothing to version. */
  | "no_change"
  /** The stored DAG has no readable `steps` array. */
  | "malformed_dag"
  /** A `gate_fix` that did not come from a gate refusal. Only the gate-repair
   *  service may carry one; anything else is refused, never applied. */
  | "gate_fix_without_gate_block"
  /** The stored `gate_fix` operations are not what its fixer computes against
   *  this definition — the steps moved since it was proposed. */
  | "gate_fix_mismatch";

export type PatchApplyOutcome =
  | {
      ok: true;
      dag: Record<string, unknown>;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      changed_paths: string[];
    }
  | { ok: false; reason: PatchApplyFailure };

/** The drift kind a candidate's stored diff recorded, or null. */
export function candidateDriftKind(diff: unknown): string | null {
  const signal = (diff as { drift_signal?: { kind?: unknown } } | null)?.drift_signal;
  return typeof signal?.kind === "string" ? signal.kind : null;
}

function readSteps(dag: unknown): Record<string, unknown>[] | null {
  if (!dag || typeof dag !== "object" || Array.isArray(dag)) return null;
  const steps = (dag as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return null;
  return steps as Record<string, unknown>[];
}

/**
 * Rewrite the patched step inside a workflow DAG and hand back the new DAG.
 *
 * The step is addressed by `step_key` — the DAG step's `id`, which is what
 * `execution_steps.step_key` records for the failing step, so the drift signal
 * and the definition line up without a second identity.
 *
 * `steps` is a flat array (branch/parallel/loop reference their bodies by id),
 * so a single pass finds the target — no recursion needed.
 */
export function applyPatchToWorkflowDag(
  dag: unknown,
  step_key: string | null,
  patch: PatchProposal,
  /** The kind of the drift signal the candidate recorded. A `gate_fix` is
   *  executable only when it is `gate_block`. */
  drift_kind?: string | null,
): PatchApplyOutcome {
  if (!step_key) return { ok: false, reason: "no_step_anchor" };
  const steps = readSteps(dag);
  if (!steps) return { ok: false, reason: "malformed_dag" };

  const index = steps.findIndex((s) => s && typeof s === "object" && s.id === step_key);
  if (index < 0) return { ok: false, reason: "step_not_found" };
  const before = steps[index] as Record<string, unknown>;

  if (patch.kind === "gate_fix")
    return applyGateFix(dag, steps, index, step_key, patch, drift_kind);

  const kind = before.kind;
  if (kind !== "request" && kind !== "transform") {
    return { ok: false, reason: "unsupported_step_kind" };
  }

  const rewrite = resolvePathRewrite(patch);
  if (!rewrite) return { ok: false, reason: "patch_not_applicable" };

  const after = applyRewriteToSlots(before as ProjectionSlots, rewrite, kind) as Record<
    string,
    unknown
  >;
  const changed_paths = diffStepPaths(before, after);
  if (changed_paths.length === 0) return { ok: false, reason: "no_change" };

  const nextSteps = [...steps];
  nextSteps[index] = after;
  return {
    ok: true,
    dag: { ...(dag as Record<string, unknown>), steps: nextSteps },
    before,
    after,
    changed_paths,
  };
}

/**
 * A gate fix is re-planned against the definition it would change and must
 * reproduce the stored operations exactly: the fixer, not the stored value,
 * decides what is written. A definition that moved since the proposal yields
 * a different plan (or none) and the fix is refused.
 */
function applyGateFix(
  dag: unknown,
  steps: Record<string, unknown>[],
  index: number,
  step_key: string,
  patch: PatchProposal,
  drift_kind: string | null | undefined,
): PatchApplyOutcome {
  if (drift_kind !== "gate_block") return { ok: false, reason: "gate_fix_without_gate_block" };
  const parsed = GateFixPatchSchema.safeParse(patch.patch);
  if (!parsed.success || parsed.data.step_id !== step_key)
    return { ok: false, reason: "patch_not_applicable" };
  const plan = replanGateFix(dag, parsed.data);
  if (!plan) {
    // Already repaired: the cause the fixer removes is gone from this version.
    if (parsed.data.fixer === "use_utf8_encoder" && alreadyUtf8(steps[index]))
      return { ok: false, reason: "no_change" };
    if (
      parsed.data.fixer === "declare_report_delivery" &&
      workflowJsonDigest(steps[index]?.report_delivery ?? null) ===
        workflowJsonDigest(parsed.data.ops[0]?.value ?? null)
    )
      return { ok: false, reason: "no_change" };
    return { ok: false, reason: "gate_fix_mismatch" };
  }
  if (
    plan.step_id !== step_key ||
    workflowJsonDigest(plan.ops) !== workflowJsonDigest(parsed.data.ops)
  )
    return { ok: false, reason: "gate_fix_mismatch" };
  const before = steps[index] as Record<string, unknown>;
  const after = applyGateFixOps(before, plan.ops);
  const changed_paths = diffStepPaths(before, after);
  if (changed_paths.length === 0) return { ok: false, reason: "no_change" };
  const nextSteps = [...steps];
  nextSteps[index] = after;
  return {
    ok: true,
    dag: { ...(dag as Record<string, unknown>), steps: nextSteps },
    before,
    after,
    changed_paths,
  };
}

function alreadyUtf8(step: Record<string, unknown> | undefined): boolean {
  const expression = step?.expression;
  return (
    typeof expression === "string" &&
    expression.includes("sk.base64UrlEncodeUtf8(") &&
    !/(?<![\w$.])sk\.base64UrlEncode\(/.test(expression)
  );
}
