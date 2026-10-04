import { logger } from "../../logging/logger.ts";
import { extractStepIdReferences, suggestClosest } from "../../workflows/levenshtein.ts";
import type { BranchStep } from "../../workflows/types.ts";
import { buildJsonataBindings, resolveScopeForJsonata } from "../jsonata-bindings.ts";
import { compile as compileJsonata } from "../jsonata-engine.ts";
import type { StepResult, StepRunContext } from "../types.ts";
import { buildStepErrorDetail } from "./error-detail.ts";

export async function runBranchStep(p: {
  ctx: StepRunContext;
  step: BranchStep;
  scope: Record<string, unknown>;
}): Promise<StepResult> {
  const start = Date.now();
  try {
    const expr = compileJsonata(p.step.when);
    p.scope = await resolveScopeForJsonata(p.ctx.db, p.ctx.tenant_id, p.scope, p.ctx.signal);
    const bindings = buildJsonataBindings(p.scope, (p.scope as { $input?: unknown }).$input);
    const matched = await expr.evaluate(p.scope, bindings);
    const truthy = !!matched;

    const warnings: NonNullable<StepResult["warnings"]> = [];
    {
      const referenced = extractStepIdReferences(p.step.when);
      const scopeKeys = Object.keys(p.scope).filter((k) => !k.startsWith("$"));
      const didYouMean: Array<{ from: string; to: string[] }> = [];
      for (const ref of referenced) {
        if (!scopeKeys.includes(ref)) {
          const matches = suggestClosest(ref, scopeKeys, 3);
          if (matches.length > 0) didYouMean.push({ from: ref, to: matches });
        }
      }
      if (didYouMean.length > 0) {
        const sample = didYouMean[0]!;
        const armWord = truthy ? "then" : "else";
        warnings.push({
          code: "branch_when_unresolved" as const,
          identifier: p.step.id,
          message: `branch "${p.step.id}" predicate \`${p.step.when}\` references unknown step \`${sample.from}\` (did you mean: ${sample.to.map((s) => `\`${s}\``).join(", ")}). The expression resolved to falsy → arm="${armWord}". Available scope keys: ${scopeKeys.slice(0, 8).join(", ")}.`,
          details: {
            when: p.step.when,
            available_scope_keys: scopeKeys.slice(0, 8),
            did_you_mean: didYouMean,
          },
        });
      }
    }

    logger.debug({
      module: "execution",
      action: "step.branch.evaluated",
      step_id: p.step.id,
      matched: truthy,
      arm: truthy ? "then" : "else",
    });
    return {
      status: "succeeded",
      output: { matched: truthy, arm: truthy ? "then" : "else" },
      retry_count: 0,
      duration_ms: Date.now() - start,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "step.branch.error",
      step_id: p.step.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: buildStepErrorDetail({ code: "branch_error", err }),
    };
  }
}
