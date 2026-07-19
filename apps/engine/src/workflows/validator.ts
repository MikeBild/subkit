// Workflow validator. Wraps the zod schema with extra structural rules:
// - step ids must be unique
// - referenced child step ids on parallel/loop/branch must exist
// - data_selector must parse as a JSONPath-lite expression
// - request urls must be syntactically valid
// - transform expressions (JavaScript function bodies) must parse
// - loop bodies must reference the iteration item (`$item` in JSONata,
//   `${item.…}` in strings) — otherwise the loop is N copies of the
//   same call, typically a bug. Legacy stored versions that declare
//   `item_var` validate under their declared contract; NEW definitions
//   must not declare `item_var` at all (retired authoring field).
//
// Static JSONata identifier-scope checking lives at runtime in
// `apps/engine/src/execution/steps/transform.ts` so the engine has the
// actual scope/bindings shape — the warnings it emits are forwarded
// onto `RunResult.warnings` and trigger the `partial_success` gate in
// `run-workflow.ts` that refuses the commit.

import { compileOutputContractSchema } from "../execution/output-contract.ts";
import { compileSelector } from "../execution/selectors.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import { detectReservedAuthHeaders } from "./header-policy.ts";
import { synthesizeInputSchema } from "./input-schema-synth.ts";
import { suggestClosest } from "./levenshtein.ts";
import { type StepDef, type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION } from "./types-web-scraper.ts";

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
 * Subkit's incremental authoring flow declares steps one at a time, so
 * it needs leniency at authoring boundaries; the strict gate stays at
 * preview / commit so the saved workflow is never broken.
 */
export interface ValidateOptions {
  /** When true, unknown control-flow targets become `forward_refs`
   *  instead of `errors`. Default false (strict). */
  allowForwardRefs?: boolean;
  /** Connector IDs whose saved `auth_type === "none"`. Steps that
   *  reference one of these may carry step-level Authorization (the
   *  multi-step token-mint pattern documented in the auth-flows skill).
   *  Callers with DB access pass this set; raw-API validation paths
   *  omit it and the reserved-auth-header check fires for every
   *  connector_id step. */
  noneAuthConnectorIds?: ReadonlySet<string>;
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
      // `loop` step's `data_selector` is a JS arrow function (the source-
      // array selector evaluated by runLoopStep via runJs). It shares the
      // field name with baseStep's output-projector `data_selector` but has
      // different semantics — skip the JSONPath compile check for loop steps.
      if (step.kind !== "loop") {
        try {
          compileSelector(step.data_selector);
        } catch (e) {
          errors.push({
            path: `steps.${step.id}.data_selector`,
            message: e instanceof Error ? e.message : String(e),
          });
        }
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
      // Commit-time placeholder resolvability (audit M4). The runtime
      // FAILS FAST with `placeholder_unresolved` when the request's
      // addressing surfaces — path/url, the s3 key/prefix, the graphql
      // query/variables — still carry tokens the resolver cannot
      // substitute (see execution/steps/request/dispatch.ts). Production
      // logged 67 runs of `unresolved placeholder(s) in path/url: ${item}`
      // in 2 seconds: the bare `${item}` (no field path) is a grammar
      // error the resolver can never resolve, yet it slipped past both the
      // unsupported-placeholder linter (known kind → skipped) and the
      // item-containment check (`item.` + field required). Parse the same
      // grammar the resolver uses and reject at the same gate that already
      // rejects unparseable JSONata: malformed placeholders always, and
      // `${scope.<step>…}` naming an unknown step in strict mode (lenient
      // authoring may reference steps not written yet — the strict gate at
      // preview/commit still catches them).
      errors.push(...collectAddressingPlaceholderErrors(step, ids, allowForwardRefs));
    }
    if (
      step.kind === "transform" &&
      typeof step.expression === "string" &&
      step.expression.length > 0 &&
      // Web-scraper languages (readability / html-to-markdown / structured-data)
      // carry no `expression` — their config blocks do. Everything else is a
      // JavaScript transform body.
      !TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION.has(step.language ?? "javascript")
    ) {
      try {
        // Parse-only JS syntax check: the QuickJS sandbox wraps the body as
        // `(function(input){ <expression> })`, so `new Function("input", body)`
        // compiles it under the same grammar without executing it (parse-only).
        new Function("input", step.expression);
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
      // `item_var` is retired from the authored contract. Loop items
      // are addressed as `$item` (JSONata) / `${item.…}` (strings).
      // This is THE single enforcement point: every write surface
      // (HTTP create/update, conversation authoring tools, draft
      // executions) flows through validateWorkflowDef, while stored
      // legacy versions are only Zod-parsed on read/execute and keep
      // running under their declared contract (see
      // `execution/loop-scope.ts`).
      if (step.item_var !== undefined) {
        errors.push({
          path: `steps.${step.id}.item_var`,
          message:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: operator-facing message names the literal `${item.…}` placeholder grammar.
            "`item_var` is retired — remove it. Address the loop item as `$item` in JSONata expressions and `${item.<field>}` in URL/header/query/body strings (`$loop_index` is the iteration counter).",
        });
      }
      // The body must reference the iteration item somewhere. A loop
      // whose body never reads the iteration item is N copies of the
      // same call — almost always a bug. The transcript that triggered
      // this rule had `body: [get_resources]` where `get_resources`
      // hard-coded the URL with no `${project.id}` interpolation, so
      // the loop ran but never fanned out.
      const bodySteps = step.body
        .map((bid) => wf.steps.find((s) => s.id === bid))
        .filter((s): s is StepDef => s !== undefined);
      // A loop body satisfies the reference rule when it mentions either
      //   - the canonical placeholder `${item.…}` (for URLs / headers /
      //     query / body strings), or
      //   - the canonical `$item` binding (for JSONata expressions).
      // Legacy definitions that declare `item_var` (stored versions —
      // they are rejected above for new writes, but this rule must not
      // double-fire on them) still validate under their declared
      // contract: the bare declared name counts as a reference.
      // Skip the check when ANY body id is still a forward reference —
      // the LLM hasn't authored that step yet, so we cannot tell whether
      // it will read the iteration item.
      const someBodyIsForwardRef = step.body.some((bid) => !ids.has(bid));
      const declaredItemVar = step.item_var;
      const referencesItem = bodySteps.some(
        (bs) =>
          stepReferencesCanonicalItem(bs) ||
          (declaredItemVar !== undefined && stepReferencesIdentifier(bs, declaredItemVar)),
      );
      if (bodySteps.length > 0 && !someBodyIsForwardRef && !referencesItem) {
        errors.push({
          path: `steps.${step.id}`,
          message:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: operator-facing message names the literal `${item.field}` placeholder grammar.
            "loop body never references the iteration item — use `${item.field}` in URLs/strings or `$item.field` in JSONata. Without it the loop runs N copies of the same call.",
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
    // A step with `for_each` declared is its own iteration context —
    // it binds `$item` per element, so `${item.…}` placeholders are
    // valid without a surrounding `loop` wrapper.
    if (step.for_each !== undefined) continue;
    const haystack = JSON.stringify(step);
    if (ITEM_PLACEHOLDER_RE.test(haystack)) {
      errors.push({
        path: `steps.${step.id}`,
        message:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${item.…}` token names the placeholder grammar surfaced to the LLM.
          'step uses `${item.…}` placeholder but is not contained in any `loop.body[]` and has no `for_each` declared. Set `for_each: "(sourceData) => sourceData.<prev_step>.<array_path>"` on this step to bind `$item` per element (the placeholder resolver only sets `$item` inside a `for_each` iteration or a loop body).',
      });
    }
  }

  // Reserved auth headers (Authorization / Cookie / Proxy-Authorization)
  // on a `connector_id` request step. The connector's saved credential
  // injects auth at execution time; a step-level header overrides it
  // and is almost always a placeholder string the LLM authored that
  // doesn't expand against the resolved credential namespace.
  // `build_workflow` already refuses these at draft-build time
  // (conversation 730c568a); this check stays as defence in depth for
  // mutation paths (`update_param`, `edit_workflow_patch`, raw API).
  // Skipped for connector_ids whose `auth_type === "none"` — see the
  // `auth-flows.md` skill's multi-step token-mint pattern.
  // Output contract sanity (Fix 11). `output_schema` is the workflow's
  // public output contract: dry-run previews block on a violation and
  // live runs attach a non-blocking `output_contract_violation`
  // warning. A schema Ajv cannot compile would silently disable both
  // surfaces, so refuse it here — at the same gate that already
  // refuses unparseable JSONata.
  if (wf.output_schema) {
    const compiled = compileOutputContractSchema(wf.output_schema);
    if (!compiled.ok) {
      errors.push({
        path: "output_schema",
        message: `output_schema is not a valid JSON Schema: ${compiled.error}`,
      });
    }
  }

  for (const v of detectReservedAuthHeaders(
    wf.steps,
    options.noneAuthConnectorIds ? { noneAuthConnectorIds: options.noneAuthConnectorIds } : {},
  )) {
    errors.push({ path: v.path, message: v.message });
  }

  // Input-schema drift check (E4 / W4c-input_schema-drift).
  //
  // When `input_schema` is declared and carries a `properties` map, verify
  // that every `$input.<key>` / `input.<key>` reference in step strings and
  // expressions actually names a declared property.  A referenced key that is
  // absent from `properties` would resolve to `undefined` at runtime and the
  // step would silently receive an empty placeholder — exactly the drift that
  // produced the essay-word-count failure.
  //
  // We deliberately do NOT flag the reverse direction (a declared `required`
  // key that no step references): a step may consume `$input` / `input`
  // wholesale, and JS-transform steps read `input.<key>` in a way the
  // reference extractor cannot see — so "required but unreferenced" is a
  // false-positive magnet, not a reliable signal.
  //
  // The check is skipped when `input_schema` is absent: the synthesiser
  // produces a schema on-the-fly from the references themselves, so there can
  // be no declared-vs-referenced mismatch.
  if (wf.input_schema && typeof wf.input_schema === "object") {
    const declaredProps = (wf.input_schema as { properties?: unknown }).properties;
    if (declaredProps && typeof declaredProps === "object" && !Array.isArray(declaredProps)) {
      const declaredKeys = new Set(Object.keys(declaredProps as Record<string, unknown>));
      // Reuse the same reference-extraction logic the synthesiser uses so
      // the two surfaces always agree on what counts as an `$input.*` ref.
      const synth = synthesizeInputSchema(wf);
      const referencedKeys = new Set(synth ? Object.keys(synth.properties) : []);

      // 1. Referenced but not declared → runtime placeholder will be empty.
      for (const key of referencedKeys) {
        if (!declaredKeys.has(key)) {
          errors.push({
            path: "input_schema",
            message: `step references input key "${key}" which is not declared in input_schema.properties — add it or remove the reference`,
          });
        }
      }
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

/** Canonical iteration-item references: `${item.…}` in strings,
 *  `$item` in JSONata. Conservative substring/regex check over the
 *  serialized step — errs towards false-positives (lets the loop
 *  validate) like `stepReferencesIdentifier`. */
function stepReferencesCanonicalItem(step: StepDef): boolean {
  const haystack = JSON.stringify(step);
  return haystack.includes("${item") || /\$item\b/.test(haystack);
}

/**
 * Placeholder resolvability for a request step's ADDRESSING surfaces —
 * exactly the fields the runtime refuses to dispatch with an unresolved
 * token (`placeholder_unresolved` in dispatch.ts): `path`, `url`,
 * `s3.key`, `s3.prefix`, `graphql.query` and string leaves of
 * `graphql.variables`. Headers / query / body are deliberately NOT
 * scanned: the runtime ships unresolved tokens there literally (partial
 * resolution is the resolver's contract), so rejecting them here would
 * be stricter than the engine itself.
 *
 * Two error classes:
 *   - grammar errors from `parsePlaceholders` (`${item}` without a path,
 *     `${scope.x}` without a pointer, unknown kinds, unclosed braces) —
 *     always fatal, no execution scope can ever resolve them;
 *   - `${scope.<step>…}` naming a step id that isn't in the workflow —
 *     fatal in strict mode only (`allowForwardRefs` authoring surfaces
 *     legitimately reference steps that don't exist yet).
 */
function collectAddressingPlaceholderErrors(
  step: Extract<StepDef, { kind: "request" }>,
  ids: ReadonlySet<string>,
  allowForwardRefs: boolean,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const surfaces: Array<{ field: string; text: string }> = [];
  const addSurface = (field: string, text: unknown): void => {
    if (typeof text === "string" && text.length > 0) surfaces.push({ field, text });
  };
  addSurface("path", step.path);
  addSurface("url", step.url);
  addSurface("s3.key", step.s3?.key);
  addSurface("s3.prefix", step.s3?.prefix);
  if (step.graphql && typeof step.graphql === "object") {
    addSurface("graphql.query", step.graphql.query);
    const walkVariables = (value: unknown, at: string): void => {
      if (typeof value === "string") {
        addSurface(at, value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => {
          walkVariables(v, `${at}.${i}`);
        });
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          walkVariables(v, `${at}.${k}`);
        }
      }
    };
    if (step.graphql.variables) walkVariables(step.graphql.variables, "graphql.variables");
  }
  for (const { field, text } of surfaces) {
    const parsed = parsePlaceholders(text);
    for (const e of parsed.errors) {
      errors.push({
        path: `steps.${step.id}.${field}`,
        message: `unresolvable placeholder \`${text.slice(e.span.start, e.span.end)}\`: ${e.message} — the runtime would fail this step with placeholder_unresolved`,
      });
    }
    if (allowForwardRefs) continue;
    for (const token of parsed.tokens) {
      if (token.kind !== "scope") continue;
      const stepId = token.stepId ?? "";
      if (ids.has(stepId)) continue;
      const near = suggestClosest(stepId, [...ids], 3);
      errors.push({
        path: `steps.${step.id}.${field}`,
        message: `placeholder \`${token.raw}\` references unknown step "${stepId}"${near.length > 0 ? ` — did you mean: ${near.join(", ")}` : ""}`,
      });
    }
  }
  return errors;
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
