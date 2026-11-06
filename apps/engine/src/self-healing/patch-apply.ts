import { compileSelector } from "../execution/selectors.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { applyGateFixOps, GateFixPatchSchema, replanGateFix } from "../workflows/gate-fix.ts";

export interface ProjectionSlots {
  data_selector?: string | undefined;
  expression?: string | undefined;
}

type PatchableStepKind = "request" | "transform";

export interface PathRewrite {
  from: string | null;
  to: string;
}

function toDottedPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const dotted = raw.replace(/^\//, "").replace(/\//g, ".");
  return dotted.length > 0 ? dotted : null;
}

export function resolvePathRewrite(patch: PatchProposal): PathRewrite | null {
  if (patch.kind !== "update_field_path") return null;
  const body = patch.patch as Record<string, unknown>;
  const to = toDottedPath(body.value);
  if (!to) return null;
  return { from: toDottedPath(body.path), to };
}

export function applyRewriteToSlots<T extends ProjectionSlots>(
  slots: T,
  rewrite: PathRewrite,
  kind: PatchableStepKind,
): T {
  const next: T = { ...slots };
  if (kind === "request") {
    if (next.data_selector) {
      if (rewrite.from) {
        next.data_selector = next.data_selector.split(rewrite.from).join(rewrite.to);
      }
    } else {
      next.data_selector = rewrite.to;
    }
    return next;
  }
  if (next.expression && rewrite.from) {
    next.expression = next.expression.split(rewrite.from).join(rewrite.to);
  }
  return next;
}

function compilesAsSelector(selector: unknown): boolean {
  if (typeof selector !== "string") return false;
  try {
    compileSelector(selector);
    return true;
  } catch {
    return false;
  }
}

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

export type PatchApplyFailure =
  | "no_step_anchor"
  | "step_not_found"
  | "unsupported_step_kind"
  | "patch_not_applicable"
  | "no_change"
  | "malformed_dag"
  | "gate_fix_without_gate_block"
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

export function applyPatchToWorkflowDag(
  dag: unknown,
  step_key: string | null,
  patch: PatchProposal,
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
  if (changed_paths.includes("data_selector") && !compilesAsSelector(after.data_selector))
    return { ok: false, reason: "patch_not_applicable" };

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
