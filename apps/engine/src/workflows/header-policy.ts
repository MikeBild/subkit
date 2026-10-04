import type { StepDef } from "./types.ts";

const RESERVED_HEADER_NAMES = ["authorization", "cookie", "proxy-authorization"] as const;

export interface ReservedAuthHeaderViolation {
  step_id: string;
  header_name: string;
  path: string;
  message: string;
}

export interface DetectReservedAuthHeadersOptions {
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
