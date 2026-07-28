// Fixture dry-runner for self-healing patches.
//
// The dry-run NEVER hits the network. Instead it takes a patched step
// definition + a recorded `execution_fixtures` row and:
//
//   1. treats `fixture.response` as the raw HTTP body the connector
//      would have returned for this request,
//   2. applies the patch's `data_selector` / `expression` to project
//      a value out of that body.
//
// If projection succeeds — meaning the JSONata expression resolves to
// a non-undefined value (or the selector walks cleanly) — the dry-run
// passes. Any throw or `undefined` result fails the gate.
//
// The rules are intentionally loose. A fixture sample that a patched
// step cannot even parse is definitely broken, so we reject it.
// A fixture sample that the patched step successfully projects is
// *probably* right — the classifier already gated the patch to the
// narrow safe palette, so a successful projection is the last
// signal the engine needs before auto-applying.

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

/**
 * Apply a PatchProposal to a copy of the step so the dry-run projects the
 * fixture through the SAME rewrite the apply path will write into the
 * workflow. Both go through `patch-apply.ts`; that shared function is why a
 * green dry-run predicts the applied version instead of merely resembling it.
 * The original step object is never mutated.
 *
 * Kinds without executable semantics (`rename_param`, `add_header`,
 * `change_type`) leave the step untouched here — and are refused outright by
 * the apply path, so a dry-run cannot bless a patch the engine can't perform.
 */
export function applyPatchToStep(step: DryRunStep, patch: PatchProposal): DryRunStep {
  const rewrite = resolvePathRewrite(patch);
  if (!rewrite) return { ...step };
  return applyRewriteToSlots(step, rewrite, step.kind);
}

/**
 * Project the fixture's response through the patched step. Returns
 * `{ok: true}` on a non-undefined value, `{ok: false, error}` on an
 * undefined result or a thrown exception.
 */
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

  // Transform step: JSONata against the fixture response directly.
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

  // Request step: the data_selector is applied post-response. We
  // interpret it as a JSONata expression walking the response body.
  const selector = patched.data_selector;
  if (!selector) {
    // No selector — a request step with no projection is trivially OK
    // as long as the fixture response parses.
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
