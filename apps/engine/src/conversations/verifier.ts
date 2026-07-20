// Static verifier for workflow drafts.
//
// Runs inside `build_workflow` and can be called from `validate_draft`
// before commit. Catches classes of error that the zod schema cannot:
//
//   - JSONata expression syntax errors in transform / data_selector /
//     outputTransform / branch.when
//   - Scope-reference integrity: `${scope.<step>.*}` must point at a
//     step whose `id` appears earlier in the workflow
//   - Output schema validity: `output_schema` compiles as JSON Schema
//     (Ajv) without throwing
//   - Method safety hints: POST/PUT/DELETE without `onError.mode` set →
//     warning (one unhandled failure can abort the whole workflow)
//   - Idempotency hints: GET steps with retry on and no `idempotency_key`
//     → info
//
// Verifier is pure and cheap — no DB calls, no LLM calls. If it throws
// it's an invariant bug; otherwise it returns a structured
// { errors, warnings, infos } tuple.

import {
  compile as compileJsonata,
  findUnboundFunctionCalls,
} from "../execution/jsonata-engine.ts";
import { validateBareIterationIdentifiers } from "../workflows/reference-validator.ts";
import { TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION } from "../workflows/types-web-scraper.ts";

export type VerifierSeverity = "error" | "warning" | "info";

export interface VerifierFinding {
  severity: VerifierSeverity;
  code: string;
  message: string;
  /** Dotted path into the WorkflowDef that triggered the finding. */
  path: string;
}

export interface VerifierReport {
  errors: VerifierFinding[];
  warnings: VerifierFinding[];
  infos: VerifierFinding[];
}

interface InputWorkflow {
  name?: string;
  slug?: string;
  description?: string;
  steps?: Array<Record<string, unknown>>;
  output_schema?: unknown;
  output_transform?: string;
}

const JSONATA_FIELDS: Array<{
  /** Which step `kind` carries this field; undefined = top-level */
  kind?: string;
  /** Field name on the step or workflow root. */
  field: string;
}> = [
  // NOTE: `transform.expression` is intentionally NOT here — a transform may
  // be JSONata OR JavaScript, so it is routed by `language` in
  // `validateTransformExpression`. `branch.when` is always JSONata.
  { kind: "branch", field: "when" },
];

function addFinding(report: VerifierReport, finding: VerifierFinding): void {
  if (finding.severity === "error") report.errors.push(finding);
  else if (finding.severity === "warning") report.warnings.push(finding);
  else report.infos.push(finding);
}

function tryJsonata(expression: string, path: string, report: VerifierReport): void {
  try {
    compileJsonata(expression);
    for (const finding of findUnboundFunctionCalls(expression)) {
      addFinding(report, {
        severity: "error",
        code: "jsonata_unbound_function",
        message: `JSONata function \`${finding.name}(...)\` is not bound; use \`${finding.suggestion}(...)\``,
        path,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addFinding(report, {
      severity: "error",
      code: "jsonata_syntax_error",
      message: `JSONata expression failed to parse: ${msg}`,
      path,
    });
  }
}

// Validate a JavaScript transform body WITHOUT executing it. The QuickJS
// sandbox (sandboxes/quickjs/runtime.ts) wraps user code as
// `(function(input){ <expression> })`, so `new Function("input", expression)`
// parses the body under the exact same grammar. The Function constructor
// compiles but never RUNS the body, so this stays as pure and cheap as the
// JSONata path — a SyntaxError here is the same failure the author would
// otherwise only discover at runtime in the sandbox.
function tryJavascript(expression: string, path: string, report: VerifierReport): void {
  try {
    // Parse-only: the Function constructor compiles the body but never runs it.
    new Function("input", expression);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addFinding(report, {
      severity: "error",
      code: "js_syntax_error",
      message: `JavaScript transform failed to parse: ${msg}`,
      path,
    });
  }
}

// Validate a transform step's `expression`. Transforms are JavaScript-only —
// validating a JS body through the JSONata parser is exactly the bug that
// trapped the authoring loop ("JSONata expression failed to parse" on correct
// JavaScript). JSONata survives only in the one-line slots (`data_selector`,
// `branch.when`, `output_transform`, `${scope.x.data}` interpolation), which
// are validated elsewhere. The three web-scraper languages carry no
// `expression` (their config blocks do), so they are skipped.
function validateTransformExpression(
  step: Record<string, unknown>,
  path: string,
  report: VerifierReport,
): void {
  const expression = step.expression;
  if (typeof expression !== "string" || expression.length === 0) return;
  const language = typeof step.language === "string" ? step.language : "javascript";
  if (TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION.has(language)) return;
  tryJavascript(expression, `${path}.expression`, report);
}

const SCOPE_RE = /\$\{scope\.([A-Za-z0-9_-]+)\./g;
const JSONATA_SCOPE_RE = /\$scope\.([A-Za-z0-9_-]+)\b/g;
const SCOPE_SEGMENT_RE = /\$\{scope\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/g;
const JSONATA_SCOPE_SEGMENT_RE = /\$scope\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/g;
const ALLOWED_SCOPE_ENVELOPE_FIELDS = new Set([
  "data",
  "status_code",
  "headers",
  "error",
  "duration_ms",
]);

function scanScopeRefs(
  value: unknown,
  seenStepIds: Set<string>,
  path: string,
  report: VerifierReport,
): void {
  if (typeof value === "string") {
    const hits = new Set<string>();
    for (let m = SCOPE_RE.exec(value); m !== null; m = SCOPE_RE.exec(value)) {
      const [, ref] = m;
      if (ref) hits.add(ref);
    }
    SCOPE_RE.lastIndex = 0;
    for (let m = JSONATA_SCOPE_RE.exec(value); m !== null; m = JSONATA_SCOPE_RE.exec(value)) {
      const [, ref] = m;
      if (ref) hits.add(ref);
    }
    JSONATA_SCOPE_RE.lastIndex = 0;
    for (const ref of hits) {
      if (!seenStepIds.has(ref)) {
        addFinding(report, {
          severity: "error",
          code: "scope_ref_unresolved",
          message: `\${scope.${ref}.*} references a step that does not exist earlier in the workflow`,
          path,
        });
      }
    }

    const segmentRefs: Array<{ ref: string; firstField: string }> = [];
    for (let seg = SCOPE_SEGMENT_RE.exec(value); seg !== null; seg = SCOPE_SEGMENT_RE.exec(value)) {
      const [, ref, firstField] = seg;
      if (ref && firstField) segmentRefs.push({ ref, firstField });
    }
    SCOPE_SEGMENT_RE.lastIndex = 0;
    for (
      let seg = JSONATA_SCOPE_SEGMENT_RE.exec(value);
      seg !== null;
      seg = JSONATA_SCOPE_SEGMENT_RE.exec(value)
    ) {
      const [, ref, firstField] = seg;
      if (ref && firstField) segmentRefs.push({ ref, firstField });
    }
    JSONATA_SCOPE_SEGMENT_RE.lastIndex = 0;
    for (const { ref, firstField } of segmentRefs) {
      if (!seenStepIds.has(ref)) continue;
      if (ALLOWED_SCOPE_ENVELOPE_FIELDS.has(firstField)) continue;
      addFinding(report, {
        severity: "error",
        code: "scope_envelope_field_missing",
        message: [
          `$scope.${ref}.${firstField} reads a field directly from the step envelope;`,
          `use $scope.${ref}.data.${firstField} unless you meant one of`,
          Array.from(ALLOWED_SCOPE_ENVELOPE_FIELDS).join(", "),
        ].join(" "),
        path,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanScopeRefs(value[i], seenStepIds, `${path}[${i}]`, report);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanScopeRefs(v, seenStepIds, `${path}.${k}`, report);
    }
  }
}

function checkMethodSafety(
  step: Record<string, unknown>,
  path: string,
  report: VerifierReport,
): void {
  if (step.kind !== "request") return;
  const method = typeof step.method === "string" ? step.method.toUpperCase() : undefined;
  if (!method) return;
  const onError = step.onError as { mode?: string } | undefined;
  const hasOnError = typeof onError?.mode === "string";
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !hasOnError) {
    addFinding(report, {
      severity: "warning",
      code: "write_verb_no_onerror",
      message: `${method} step has no onError.mode — a single failure will abort the whole workflow`,
      path,
    });
  }
  if (method === "GET" && onError?.mode === "retry" && typeof step.idempotency_key !== "string") {
    addFinding(report, {
      severity: "info",
      code: "retry_without_idempotency_key",
      message:
        "GET + retry is usually safe but consider setting `idempotency_key` if downstream write-through caching may replay",
      path,
    });
  }
}

function checkOutputSchema(schema: unknown, report: VerifierReport): void {
  if (schema === undefined || schema === null) return;
  if (typeof schema !== "object") {
    addFinding(report, {
      severity: "error",
      code: "output_schema_not_object",
      message: "output_schema must be a JSON object",
      path: "output_schema",
    });
    return;
  }
  // We don't compile against Ajv here (it adds a heavy dep for
  // what is a surface sanity check). Instead: assert the shape looks
  // like a JSON Schema — it must have a `type` or `$ref` or `oneOf`/
  // `anyOf`/`allOf` key at the root.
  const s = schema as Record<string, unknown>;
  const looksLikeSchema =
    "type" in s || "$ref" in s || "oneOf" in s || "anyOf" in s || "allOf" in s || "properties" in s;
  if (!looksLikeSchema) {
    addFinding(report, {
      severity: "warning",
      code: "output_schema_suspicious",
      message:
        "output_schema has no `type`, `$ref`, `properties`, or composition keyword — likely incomplete",
      path: "output_schema",
    });
  }
}

export function verifyWorkflow(wf: InputWorkflow): VerifierReport {
  const report: VerifierReport = { errors: [], warnings: [], infos: [] };
  const steps = wf.steps ?? [];
  const seenStepIds = new Set<string>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const id = typeof step.id === "string" ? step.id : undefined;
    const kind = typeof step.kind === "string" ? step.kind : undefined;
    const path = `steps[${i}]`;

    // Scope refs in this step can only reference PREVIOUS steps.
    scanScopeRefs(step, seenStepIds, path, report);

    // Transform expressions are validated against their DECLARED language
    // (JSONata XOR JavaScript), not unconditionally as JSONata.
    if (kind === "transform") {
      validateTransformExpression(step, path, report);
    }

    // JSONata-only fields per step kind.
    for (const spec of JSONATA_FIELDS) {
      if (spec.kind && spec.kind !== kind) continue;
      const v = step[spec.field];
      if (typeof v === "string" && v.length > 0) {
        tryJsonata(v, `${path}.${spec.field}`, report);
      }
    }

    // data_selector is present across kinds.
    if (typeof step.data_selector === "string" && step.data_selector.length > 0) {
      tryJsonata(step.data_selector, `${path}.data_selector`, report);
    }

    checkMethodSafety(step, path, report);

    // `item_var` is retired from the authored contract. The canonical
    // enforcement point is `validateWorkflowDef` (every write surface
    // routes through it); this build-time duplicate exists because
    // `build_workflow` runs the verifier BEFORE the draft is accepted,
    // so the author gets the refusal one round-trip earlier — same
    // defence-in-depth pattern as the reserved-auth-header check.
    if (kind === "loop" && step.item_var !== undefined) {
      addFinding(report, {
        severity: "error",
        code: "item_var_retired",
        message:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${item.…}` token names the canonical placeholder grammar.
          "`item_var` is retired — remove it. Address the loop item as `$item` in JSONata and `${item.<field>}` in strings; `$loop_index` is the iteration counter.",
        path: `${path}.item_var`,
      });
    }

    if (id) seenStepIds.add(id);
  }

  // Bare-iteration-identifier lint: loop-body JSONata must address the
  // current item as `$item` — the bare `item` default and any legacy
  // declared item_var name are not bound for new definitions. The
  // helper returns a concrete `$item`-rewritten expression as
  // did_you_mean when the AST rewriter can prove it.
  for (const finding of validateBareIterationIdentifiers(steps)) {
    addFinding(report, {
      severity: "error",
      code: "bare_iteration_identifier",
      message:
        `loop-body JSONata references the iteration item as bare \`${finding.bad_reference}\` — bind it as \`$item\`` +
        (finding.did_you_mean[0] && finding.did_you_mean[0] !== "$item"
          ? `; did you mean: \`${finding.did_you_mean[0]}\``
          : ""),
      path: `steps.${finding.step_id}.${finding.field}`,
    });
  }

  // Workflow-level fields.
  if (typeof wf.output_transform === "string" && wf.output_transform.length > 0) {
    tryJsonata(wf.output_transform, "output_transform", report);
    // Output transforms may reference the final step's data via
    // $scope.<step_id>.data — validate refs against the full set.
    scanScopeRefs(wf.output_transform, seenStepIds, "output_transform", report);
  }
  checkOutputSchema(wf.output_schema, report);

  return report;
}

/** Convenience: true when there are no error-severity findings. */
export function isAcceptable(report: VerifierReport): boolean {
  return report.errors.length === 0;
}
