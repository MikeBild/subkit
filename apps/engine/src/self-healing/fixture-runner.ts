import { evaluate as evaluateJsonata } from "../execution/jsonata-engine.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { applyRewriteToSlots, resolvePathRewrite } from "./patch-apply.ts";
import type { DryRunFixture, DryRunResult, DryRunStep } from "./types.ts";

export interface FixtureRunParams {
  step: DryRunStep;
  patch: PatchProposal;
  fixture: DryRunFixture;
}

export function applyPatchToStep(step: DryRunStep, patch: PatchProposal): DryRunStep {
  const rewrite = resolvePathRewrite(patch);
  if (!rewrite) return { ...step };
  return applyRewriteToSlots(step, rewrite, step.kind);
}

export async function runFixtureDryRun(p: FixtureRunParams): Promise<DryRunResult> {
  return instrument({
    module: "self-healing",
    action: "fixture_dry_run",
    memory: true,
    fields: { patch_kind: p.patch.kind, step_kind: p.step.kind },
    fn: () => runFixtureDryRunImpl(p),
  });
}

async function runFixtureDryRunImpl(p: FixtureRunParams): Promise<DryRunResult> {
  const patched = applyPatchToStep(p.step, p.patch);
  const body = p.fixture.response;

  if (patched.kind === "transform") {
    const expr = patched.expression;
    if (!expr) return { ok: false, error: "transform step has no expression" };
    try {
      const value = await evaluateJsonata(expr, body);
      if (value === undefined) {
        return { ok: false, error: `transform expression '${expr}' resolved to undefined` };
      }
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const selector = patched.data_selector;
  if (!selector) {
    return { ok: true, value: body };
  }
  try {
    const value = await evaluateJsonata(selector, body);
    if (value === undefined) {
      return { ok: false, error: `data_selector '${selector}' resolved to undefined` };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
