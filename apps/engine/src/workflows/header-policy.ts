import {
  type ConnectorHeaderPolicy,
  requestHeaderViolations,
} from "../connectors/request-header-policy.ts";
import type { DomainStepDef } from "./domain-types.ts";

interface ReservedAuthHeaderViolation {
  step_id: string;
  header_name: string;
  path: string;
  message: string;
}

interface DetectReservedAuthHeadersOptions {
  connectorHeaderPolicies?: ReadonlyMap<string, ConnectorHeaderPolicy>;
}

export function detectReservedAuthHeaders(
  steps: ReadonlyArray<DomainStepDef> | ReadonlyArray<unknown>,
  opts: DetectReservedAuthHeadersOptions = {},
): ReservedAuthHeaderViolation[] {
  const violations: ReservedAuthHeaderViolation[] = [];
  for (const rawStep of steps) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const step = rawStep as Record<string, unknown>;
    if (step.kind !== "request") continue;
    const connectorId = step.connector_id;
    if (typeof connectorId !== "string") continue;
    const headers = step.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) continue;
    const stepId = typeof step.id === "string" ? step.id : "?";
    for (const headerName of requestHeaderViolations(
      headers as Record<string, unknown>,
      opts.connectorHeaderPolicies?.get(connectorId),
    )) {
      violations.push({
        step_id: stepId,
        header_name: headerName,
        path: `steps.${stepId}.headers.${headerName}`,
        message:
          `do not set a ${headerName} header on a request step that has connector_id — ` +
          `the connector injects auth from its saved credential. Saved headers cannot be overridden; ` +
          `Cookie, Proxy-Authorization and duplicate header names are forbidden. ` +
          `Authorization forwarding requires verified connector authentication that does not own it.`,
      });
    }
  }
  return violations;
}
