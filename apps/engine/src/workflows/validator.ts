// Workflow validator. Wraps the zod schema with extra structural rules:
// - step ids must be unique
// - referenced child step ids on parallel/loop/branch must exist
// - data_selector must parse as a JSONPath-lite expression
// - request urls must be syntactically valid
// - jsonata expressions must parse

import jsonata from "jsonata";
import { compileSelector } from "../execution/selectors.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

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
    if (step.kind === "transform") {
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
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, workflow: wf, errors: [] };
}
