export type ConnectorCheckPlan = "skip" | "defer_mcp_probe" | "probe_draft" | "validate_only";

export function connectorCheckPlan(
  action: "create" | "patch",
  driver: unknown,
  skipChecks: boolean,
): ConnectorCheckPlan {
  if (skipChecks) return "skip";
  if (action === "patch") return "validate_only";
  return driver === "mcp" ? "defer_mcp_probe" : "probe_draft";
}

export type ConnectorCheckStage = "validate" | "probe";

export type ConnectorCheckOutcome =
  | { created: false }
  | { updated: false }
  | { created: true; id: string; slug: string };

type ProbeOutcome = {
  ok: boolean;
  status?: number | undefined;
  error_code?: string | undefined;
  warnings?: unknown;
};

const CHECK_FAILURE_CODES = {
  validate: "CONNECTOR_VALIDATE_FAILED",
  probe: "CONNECTOR_PROBE_FAILED",
} as const;

const probeWarningList = (value: unknown): Array<{ code: string; message: string }> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is { code: string; message: string } =>
          typeof entry?.code === "string" && typeof entry?.message === "string",
      )
    : [];

const probeFailureFields = (probe: ProbeOutcome) => {
  const warnings = probeWarningList(probe.warnings);
  return {
    ok: probe.ok,
    ...(probe.status !== undefined ? { status_code: probe.status } : {}),
    ...(probe.error_code ? { error_code: probe.error_code } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

export function connectorCheckFailure(
  outcome: ConnectorCheckOutcome,
  stage: ConnectorCheckStage,
  message: string,
  extras: { issues?: Array<{ path: string; message: string }>; probe?: ProbeOutcome },
) {
  return {
    ...outcome,
    stage,
    ...(extras.probe ? { probe: probeFailureFields(extras.probe) } : {}),
    error: {
      code: CHECK_FAILURE_CODES[stage],
      message,
      ...(extras.issues ? { issues: extras.issues } : {}),
    },
  };
}
