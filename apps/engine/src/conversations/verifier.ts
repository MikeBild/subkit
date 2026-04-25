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

import jsonata from "jsonata";

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
  { kind: "transform", field: "expression" },
  { kind: "branch", field: "when" },
];

function addFinding(report: VerifierReport, finding: VerifierFinding): void {
  if (finding.severity === "error") report.errors.push(finding);
  else if (finding.severity === "warning") report.warnings.push(finding);
  else report.infos.push(finding);
}

function tryJsonata(expression: string, path: string, report: VerifierReport): void {
  try {
    jsonata(expression);
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
    let m = SCOPE_RE.exec(value);
    while (m !== null) {
      hits.add(m[1]!);
      m = SCOPE_RE.exec(value);
    }
    SCOPE_RE.lastIndex = 0;
    m = JSONATA_SCOPE_RE.exec(value);
    while (m !== null) {
      hits.add(m[1]!);
      m = JSONATA_SCOPE_RE.exec(value);
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
    let seg = SCOPE_SEGMENT_RE.exec(value);
    while (seg !== null) {
      segmentRefs.push({ ref: seg[1]!, firstField: seg[2]! });
      seg = SCOPE_SEGMENT_RE.exec(value);
    }
    SCOPE_SEGMENT_RE.lastIndex = 0;
    seg = JSONATA_SCOPE_SEGMENT_RE.exec(value);
    while (seg !== null) {
      segmentRefs.push({ ref: seg[1]!, firstField: seg[2]! });
      seg = JSONATA_SCOPE_SEGMENT_RE.exec(value);
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

    if (id) seenStepIds.add(id);
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
