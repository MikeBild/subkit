// Workflow validator. Wraps the zod schema with extra structural rules:
// - step ids must be unique
// - referenced child step ids on parallel/loop/branch must exist
// - data_selector must parse as a JSONPath-lite expression
// - request urls must be syntactically valid
// - jsonata expressions must parse
// - loop bodies must reference the parent loop's item_var (otherwise
//   the loop is N copies of the same call — typically a bug)
//
// Static JSONata identifier-scope checking lives at runtime in
// `apps/engine/src/execution/steps/transform.ts` so the engine has the
// actual scope/bindings shape — the warnings it emits are forwarded
// onto `RunResult.warnings` and trigger the `partial_success` gate in
// `run-workflow.ts` that refuses the commit.

import jsonata from "jsonata";
import { compileSelector } from "../execution/selectors.ts";
import { type StepDef, type WorkflowDef, WorkflowDefSchema } from "./types.ts";

export interface ValidationError {
  path: string;
  message: string;
}

export function validateWorkflowDef(input: unknown): {
  ok: boolean;
  workflow?: WorkflowDef;
  errors: ValidationError[];
} {
  const parsed = WorkflowDefSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.map((p) => String(p)).join("."),
        // `i.message` is typed string, but some Zod variants (discriminated
        // union errors, refinements that throw objects) leak non-strings
        // into this field. Coerce defensively so the client never renders
        // "[object Object]" in the validation-error panel.
        message: typeof i.message === "string" ? i.message : JSON.stringify(i.message),
      })),
    };
  }
  const wf = parsed.data;
  const errors: ValidationError[] = [];
  const ids = new Set<string>();
  for (const step of wf.steps) {
    if (ids.has(step.id)) {
      errors.push({ path: `steps.${step.id}`, message: "duplicate step id" });
    }
    ids.add(step.id);
  }
  for (const step of wf.steps) {
    if (step.data_selector) {
      try {
        compileSelector(step.data_selector);
      } catch (e) {
        errors.push({
          path: `steps.${step.id}.data_selector`,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (step.kind === "request") {
      // A request step must either supply an absolute URL or reference a
      // connector (plus an optional relative `path`).
      if (step.url !== undefined) {
        try {
          if (!/^https?:\/\//.test(step.url)) {
            throw new Error("url must start with http:// or https://");
          }
        } catch (e) {
          errors.push({
            path: `steps.${step.id}.url`,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      } else if (step.connector_id === undefined) {
        errors.push({
          path: `steps.${step.id}`,
          message: "request step must specify url or connector_id",
        });
      }
    }
    if (step.kind === "transform" && (step.language ?? "jsonata") === "jsonata") {
      try {
        jsonata(step.expression);
      } catch (e) {
        errors.push({
          path: `steps.${step.id}.expression`,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (step.kind === "branch") {
      for (const ref of [...step.then_steps, ...(step.else_steps ?? [])]) {
        if (!ids.has(ref)) {
          errors.push({
            path: `steps.${step.id}`,
            message: `unknown branch target: ${ref}`,
          });
        }
      }
    }
    if (step.kind === "parallel") {
      for (const branch of step.branches) {
        for (const ref of branch) {
          if (!ids.has(ref)) {
            errors.push({
              path: `steps.${step.id}`,
              message: `unknown parallel target: ${ref}`,
            });
          }
        }
      }
    }
    if (step.kind === "loop") {
      for (const ref of step.body) {
        if (!ids.has(ref)) {
          errors.push({
            path: `steps.${step.id}`,
            message: `unknown loop body target: ${ref}`,
          });
        }
      }
      // The body must reference the loop's item_var somewhere. A loop
      // whose body never reads the iteration item is N copies of the
      // same call — almost always a bug. The transcript that triggered
      // this rule had `body: [get_resources]` where `get_resources`
      // hard-coded the URL with no `${project.id}` interpolation, so
      // the loop ran but never fanned out.
      const itemVar = step.item_var ?? "item";
      const bodySteps = step.body
        .map((bid) => wf.steps.find((s) => s.id === bid))
        .filter((s): s is StepDef => s !== undefined);
      // A loop body satisfies the reference rule when it mentions either
      //   - the canonical placeholder `${item.…}` (preferred for URLs /
      //     headers / query / body strings), or
      //   - the loop's `item_var` directly (for JSONata expressions).
      const referencesItemVar = bodySteps.some(
        (bs) => stepReferencesIdentifier(bs, itemVar) || stepReferencesIdentifier(bs, "item"),
      );
      if (bodySteps.length > 0 && !referencesItemVar) {
        errors.push({
          path: `steps.${step.id}`,
          message: `loop body never references the iteration item — use \`\${item.field}\` in URLs/strings or \`${itemVar}.field\` in JSONata. Without it the loop runs N copies of the same call.`,
        });
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, workflow: wf, errors: [] };
}

function stepReferencesIdentifier(step: StepDef, identifier: string): boolean {
  // Conservative substring check. Catches `${item.foo}`, `$item`,
  // bare `item.foo`, and `item` in JSONata. We err on the side of
  // false-positives (allows the loop to validate) rather than
  // false-rejections.
  const haystack = JSON.stringify(step);
  return (
    haystack.includes(`\${${identifier}`) ||
    haystack.includes(`{{ ${identifier}`) ||
    haystack.includes(`{{${identifier}`) ||
    haystack.includes(`$${identifier}`) ||
    new RegExp(`\\b${identifier}\\b`).test(haystack)
  );
}
