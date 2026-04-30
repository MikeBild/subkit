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
import type { DryRunFixture, DryRunResult, DryRunStep } from "./types.ts";

export interface FixtureRunParams {
  step: DryRunStep;
  patch: PatchProposal;
  fixture: DryRunFixture;
}

/**
 * Apply a PatchProposal to a copy of the step, then project the
 * fixture's response through the patched selector/expression. The
 * original step object is never mutated.
 */
export function applyPatchToStep(step: DryRunStep, patch: PatchProposal): DryRunStep {
  const patched: DryRunStep = { ...step };
  const body = patch.patch as Record<string, unknown>;
  // `update_field_path` is the common case. The mock provider ships a
  // shape like `{ op: "replace", path: "/data/id", value: "data/result/id" }`.
  // We interpret that as: wherever the step referenced `data.id`, make
  // it now reference `data.result.id`.
  if (patch.kind === "update_field_path") {
    const oldPath =
      typeof body.path === "string" ? body.path.replace(/^\//, "").replace(/\//g, ".") : undefined;
    const newPath =
      typeof body.value === "string"
        ? body.value.replace(/^\//, "").replace(/\//g, ".")
        : undefined;
    if (newPath) {
      // Rewrite data_selector
      if (patched.data_selector && oldPath) {
        patched.data_selector = patched.data_selector.split(oldPath).join(newPath);
      } else if (!patched.data_selector) {
        patched.data_selector = newPath;
      }
      // Rewrite transform expression
      if (patched.expression && oldPath) {
        patched.expression = patched.expression.split(oldPath).join(newPath);
      }
    }
  } else if (patch.kind === "rename_param") {
    // The request parameter rename is applied at the connector layer,
    // not inside the projection. The dry-run still replays the old
    // response so it's a no-op here — but we leave the hook for
    // future enrichments.
  } else if (patch.kind === "add_header") {
    // Likewise no projection change.
  } else if (patch.kind === "change_type") {
    // Type widenings don't need projection rewrites.
  }
  return patched;
}

/**
 * Project the fixture's response through the patched step. Returns
 * `{ok: true}` on a non-undefined value, `{ok: false, error}` on an
 * undefined result or a thrown exception.
 */
export async function runFixtureDryRun(p: FixtureRunParams): Promise<DryRunResult> {
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
