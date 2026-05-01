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

import { compile as compileJsonata } from "../execution/jsonata-engine.ts";
import { compileSelector } from "../execution/selectors.ts";
import { type StepDef, type WorkflowDef, WorkflowDefSchema } from "./types.ts";

/**
 * Skill-schema gate. When a workflow declares `derived_from_skill_id`,
 * the workflow's `output_schema` must structurally cover the skill's
 * declared `output_schema` so a recipe-cloned workflow cannot silently
 * narrow the public contract the skill promised.
 *
 * "Cover" means: every required top-level property in the skill's
 * schema must be present in the workflow's `properties`. We do NOT
 * walk the full JSONSchema graph — most schemas the seed loader
 * produces are shallow object envelopes around the workflow output;
 * deeper structural checks would be brittle without a JSONSchema
 * validator dep, which we intentionally don't take. The check is the
 * inverse of "does the workflow declare everything the skill said
 * it would return".
 */
export interface SkillSchemaGateResult {
  ok: boolean;
  missing_fields: string[];
}

export function validateOutputSchemaSuperset(
  skill: Record<string, unknown> | null | undefined,
  workflow: Record<string, unknown> | null | undefined,
): SkillSchemaGateResult {
  if (!skill || typeof skill !== "object") return { ok: true, missing_fields: [] };
  const skillRequired = collectRequiredTopLevel(skill);
  if (skillRequired.length === 0) return { ok: true, missing_fields: [] };
  const workflowProps = collectTopLevelProps(workflow);
  const missing = skillRequired.filter((f) => !workflowProps.has(f));
  return { ok: missing.length === 0, missing_fields: missing };
}

function collectRequiredTopLevel(schema: Record<string, unknown>): string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((f): f is string => typeof f === "string");
}

function collectTopLevelProps(schema: Record<string, unknown> | null | undefined): Set<string> {
  if (!schema || typeof schema !== "object") return new Set();
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return new Set();
  return new Set(Object.keys(props as Record<string, unknown>));
}

export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Forward-reference tolerance.
 *
 * Default ("strict") mode: every `loop.body[]`, `parallel.branches[][]`,
 * `branch.then_steps[]`, and `branch.else_steps[]` id MUST already exist
 * — used by `dry_run_workflow` and `save_workflow_draft`, the
 * boundaries that can no longer recover from a missing dependency.
 *
 * "lenient" mode: unknown control-flow targets are returned as
 * structured `forward_refs` instead of `errors`. Used by the incremental
 * authoring tools (`propose_step`, `build_workflow`, `update_param`,
 * `edit_workflow_patch`) where the LLM authors a parent step before its
 * children — exactly the dependency-order mistake every screenshot in
 * session a53ae358 hit:
 *
 *   sk: I need to create the body step first.
 *   validation errors
 *   × unknown loop body target: fetch_resource_details
 *
 * Reference impl avoids this entirely because `build_tool` ships the
 * whole workflow at once. Subkit's incremental flow needs the same
 * leniency at authoring boundaries; the strict gate stays at preview /
 * commit so the saved workflow is never broken.
 */
export interface ValidateOptions {
  /** When true, unknown control-flow targets become `forward_refs`
   *  instead of `errors`. Default false (strict). */
  allowForwardRefs?: boolean;
}

export interface ForwardRef {
  /** id of the step holding the unresolved reference. */
  step_id: string;
  /** Which control-flow array carried the unknown id (`loop.body`,
   *  `parallel.branches`, `branch.then_steps`, `branch.else_steps`). */
  field: "loop.body" | "parallel.branches" | "branch.then_steps" | "branch.else_steps";
  /** The unresolved id. */
  ref: string;
}

export function validateWorkflowDef(
  input: unknown,
  options: ValidateOptions = {},
): {
  ok: boolean;
  workflow?: WorkflowDef;
  errors: ValidationError[];
  forward_refs?: ForwardRef[];
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
  const forwardRefs: ForwardRef[] = [];
  const allowForwardRefs = options.allowForwardRefs === true;
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
      // A request step's url field accepts three shapes:
      //   1. absolute http(s)://...
      //   2. ${connector.<slug>.base_url}/<path> — resolved by the
      //      execution layer's resolveStringPlaceholders against the
      //      named saved connector. Documented in
      //      apps/engine/src/llm/substitution/parser.ts.
      //   3. omitted, in which case `connector_id` (+ optional relative
      //      `path`) is required.
      // Pre-fix the validator only accepted shape 1 — sessions 18467df2
      // hit `step_update_invalid` whenever the LLM wrote shape 2 even
      // though substitution support was already there.
      if (step.url !== undefined) {
        const isAbsolute = /^https?:\/\//.test(step.url);
        const isConnectorBaseUrlPlaceholder = /^\$\{connector\.[a-z0-9_-]+\.base_url\}(\/|$)/.test(
          step.url,
        );
        if (!isAbsolute && !isConnectorBaseUrlPlaceholder) {
          errors.push({
            path: `steps.${step.id}.url`,
            message:
              // biome-ignore lint/suspicious/noTemplateCurlyInString: operator-facing message must show the literal `${connector.<slug>.base_url}` placeholder syntax — see substitution/parser.ts
              "url must start with http(s):// OR with `${connector.<slug>.base_url}` — alternatively set `connector_id` and `path` so the driver merges base_url + path",
          });
        }
      } else if (step.connector_id === undefined) {
        errors.push({
          path: `steps.${step.id}`,
          message: "request step must specify url or connector_id",
        });
      }
      // Reserved auth headers (Authorization / Cookie /
      // Proxy-Authorization) on a connector-bound step. The connector's
      // saved credential injects auth at execution time; an explicit
      // header here overrides that and is almost always a placeholder
      // string the LLM authored without realising it won't expand
      // reliably. `build_workflow` already refuses these at draft-build
      // time (conversation 730c568a); this check stays as a defence in
      // depth for paths that mutate steps after build (`update_param`,
      // `edit_workflow_patch`, raw API). Headers must be a record by
      // schema time — Fix #1 (parseHeaderLines RFC token check) closed
      // the JSON-string slipthrough — so an `unknown` shape here is a
      // real schema violation; let `WorkflowDefSchema` parse fail
      // first.
      if (
        step.connector_id !== undefined &&
        step.headers &&
        typeof step.headers === "object" &&
        !Array.isArray(step.headers)
      ) {
        for (const headerName of Object.keys(step.headers as Record<string, unknown>)) {
          const lower = headerName.toLowerCase();
          if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization") {
            errors.push({
              path: `steps.${step.id}.headers.${headerName}`,
              message: `do not set a ${headerName} header on a request step that has connector_id — the connector injects auth from its saved credential. Remove the header (the connector's auth_type drives Authorization automatically).`,
            });
          }
        }
      }
    }
    if (step.kind === "transform" && (step.language ?? "jsonata") === "jsonata") {
      try {
        compileJsonata(step.expression);
      } catch (e) {
        errors.push({
          path: `steps.${step.id}.expression`,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (step.kind === "branch") {
      for (const ref of step.then_steps) {
        if (!ids.has(ref)) {
          if (allowForwardRefs) {
            forwardRefs.push({ step_id: step.id, field: "branch.then_steps", ref });
          } else {
            errors.push({
              path: `steps.${step.id}`,
              message: `unknown branch target: ${ref}`,
            });
          }
        }
      }
      for (const ref of step.else_steps ?? []) {
        if (!ids.has(ref)) {
          if (allowForwardRefs) {
            forwardRefs.push({ step_id: step.id, field: "branch.else_steps", ref });
          } else {
            errors.push({
              path: `steps.${step.id}`,
              message: `unknown branch target: ${ref}`,
            });
          }
        }
      }
    }
    if (step.kind === "parallel") {
      for (const branch of step.branches) {
        for (const ref of branch) {
          if (!ids.has(ref)) {
            if (allowForwardRefs) {
              forwardRefs.push({ step_id: step.id, field: "parallel.branches", ref });
            } else {
              errors.push({
                path: `steps.${step.id}`,
                message: `unknown parallel target: ${ref}`,
              });
            }
          }
        }
      }
    }
    if (step.kind === "loop") {
      for (const ref of step.body) {
        if (!ids.has(ref)) {
          if (allowForwardRefs) {
            forwardRefs.push({ step_id: step.id, field: "loop.body", ref });
          } else {
            errors.push({
              path: `steps.${step.id}`,
              message: `unknown loop body target: ${ref}`,
            });
          }
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
      // Skip the check when ANY body id is still a forward reference —
      // the LLM hasn't authored that step yet, so we cannot tell whether
      // it will read the iteration item.
      const someBodyIsForwardRef = step.body.some((bid) => !ids.has(bid));
      const referencesItemVar = bodySteps.some(
        (bs) => stepReferencesIdentifier(bs, itemVar) || stepReferencesIdentifier(bs, "item"),
      );
      if (bodySteps.length > 0 && !someBodyIsForwardRef && !referencesItemVar) {
        errors.push({
          path: `steps.${step.id}`,
          message: `loop body never references the iteration item — use \`\${item.field}\` in URLs/strings or \`${itemVar}.field\` in JSONata. Without it the loop runs N copies of the same call.`,
        });
      }
    }
  }
  // Item-placeholder containment check. A step that uses `${item.X}`
  // (or the loop's documented `${<item_var>.X}`) MUST be listed in
  // some loop's `body[]`. Pre-fix the LLM commonly added the body
  // step BEFORE wrapping it in a loop, then dry_run failed at runtime
  // with `placeholder_unresolved: ${item.id}` (session a128deba). The
  // root cause is structural — caught at authoring time here so the
  // LLM gets a typed error before the run.
  const containedStepIds = new Set<string>();
  for (const step of wf.steps) {
    if (step.kind === "loop") {
      for (const bid of step.body) containedStepIds.add(bid);
    } else if (step.kind === "branch") {
      for (const bid of [...step.then_steps, ...(step.else_steps ?? [])]) {
        containedStepIds.add(bid);
      }
    } else if (step.kind === "parallel") {
      for (const branch of step.branches) {
        for (const bid of branch) containedStepIds.add(bid);
      }
    }
  }
  const ITEM_PLACEHOLDER_RE = /\$\{\s*item\.[a-zA-Z_]/;
  for (const step of wf.steps) {
    if (containedStepIds.has(step.id)) continue;
    const haystack = JSON.stringify(step);
    if (ITEM_PLACEHOLDER_RE.test(haystack)) {
      errors.push({
        path: `steps.${step.id}`,
        message:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${item.…}` token names the placeholder grammar surfaced to the LLM.
          "step uses `${item.…}` placeholder but is not contained in any `loop.body[]`. Add a `loop` step that lists this step in its `body` (the placeholder resolver only sets `$item` inside loop iterations).",
      });
    }
  }

  if (errors.length > 0) {
    return forwardRefs.length > 0
      ? { ok: false, errors, forward_refs: forwardRefs }
      : { ok: false, errors };
  }
  return forwardRefs.length > 0
    ? { ok: true, workflow: wf, errors: [], forward_refs: forwardRefs }
    : { ok: true, workflow: wf, errors: [] };
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
