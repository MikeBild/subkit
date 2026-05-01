// Reserved-auth-header policy.
//
// When a workflow step has `connector_id`, the saved connector injects
// auth (Authorization / Cookie / Proxy-Authorization) at execution time
// from its credential row. A step-level `Authorization` header overrides
// that injection — almost always a placeholder the LLM authored that
// won't resolve against the credential namespace, leaving the actual
// upstream call unauthenticated.
//
// The check is skipped for connectors whose `auth_type === "none"`: the
// `auth-flows.md` skill documents the multi-step token-mint pattern
// (login step → reuse `${scope.login.data.access_token}` as a step-level
// `Authorization` on a downstream `auth_type: "none"` connector_id step).
// That pattern is the only legitimate writer of step-level Authorization
// on a `connector_id` step.
//
// Single source of truth used by `validateWorkflowDef` and the
// `build_workflow` tool, so both layers reject identically.

import type { StepDef } from "./types.ts";

const RESERVED_HEADER_NAMES = ["authorization", "cookie", "proxy-authorization"] as const;

export interface ReservedAuthHeaderViolation {
  step_id: string;
  header_name: string;
  path: string;
  message: string;
}

export interface DetectReservedAuthHeadersOptions {
  /**
   * Connector IDs whose saved `auth_type === "none"`. Steps that reference
   * one of these connector_ids may carry step-level reserved auth headers
   * (the multi-step token-mint pattern). When omitted or empty, every
   * connector_id-bound step is checked — used by the raw-API validation
   * path that does not load connectors.
   */
  noneAuthConnectorIds?: ReadonlySet<string>;
}

export function detectReservedAuthHeaders(
  steps: ReadonlyArray<StepDef> | ReadonlyArray<unknown>,
  opts: DetectReservedAuthHeadersOptions = {},
): ReservedAuthHeaderViolation[] {
  const noneAuth = opts.noneAuthConnectorIds ?? new Set<string>();
  const violations: ReservedAuthHeaderViolation[] = [];
  for (const rawStep of steps) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const step = rawStep as Record<string, unknown>;
    if (step.kind !== "request") continue;
    const connectorId = step.connector_id;
    if (typeof connectorId !== "string") continue;
    if (noneAuth.has(connectorId)) continue;
    const headers = step.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) continue;
    const stepId = typeof step.id === "string" ? step.id : "?";
    for (const headerName of Object.keys(headers as Record<string, unknown>)) {
      const lower = headerName.toLowerCase();
      if ((RESERVED_HEADER_NAMES as readonly string[]).includes(lower)) {
        violations.push({
          step_id: stepId,
          header_name: headerName,
          path: `steps.${stepId}.headers.${headerName}`,
          message:
            `do not set a ${headerName} header on a request step that has connector_id — ` +
            `the connector injects auth from its saved credential. Remove the header ` +
            `(the connector's auth_type drives Authorization automatically). ` +
            `For multi-step token forwarding, point connector_id at a connector with ` +
            `auth_type: "none" and reference the upstream login step's token.`,
        });
      }
    }
  }
  return violations;
}
