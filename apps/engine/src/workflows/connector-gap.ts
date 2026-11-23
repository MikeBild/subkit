import { z } from "@hono/zod-openapi";

export const ConnectorGapSchema = z.object({
  connector_id: z.string().uuid(),
  connector_slug: z.string(),
  connector_name: z.string(),
  environment: z.enum(["dev", "prod"]),
  reason: z.enum(["disabled", "needs_reauth", "credential_unavailable"]),
});
export type ConnectorGap = z.infer<typeof ConnectorGapSchema>;

export const ReconnectTargetSchema = z.object({
  connector_id: z.string().uuid(),
  environment: z.enum(["dev", "prod"]),
  section: z.literal("credentials"),
});
export type ReconnectTarget = z.infer<typeof ReconnectTargetSchema>;

export function connectorGap(
  connector: {
    connector_id: string;
    connector_slug: string;
    connector_name: string;
    reason: ConnectorGap["reason"];
  },
  environment: "dev" | "prod",
): { connector: ConnectorGap; reconnect: ReconnectTarget } {
  return {
    connector: {
      connector_id: connector.connector_id,
      connector_slug: connector.connector_slug,
      connector_name: connector.connector_name,
      environment,
      reason: connector.reason,
    },
    reconnect: { connector_id: connector.connector_id, environment, section: "credentials" },
  };
}

export function vaultAttachCommand(gap: Pick<ConnectorGap, "connector_slug" | "environment">) {
  return `subkit vault attach ${gap.connector_slug} --env ${gap.environment}`;
}

const ENVIRONMENT_WORD = { dev: "development", prod: "production" } as const;

export function connectorGapInstruction(gap: ConnectorGap): string {
  const subject = `The ${ENVIRONMENT_WORD[gap.environment]} connector "${gap.connector_name}" (${gap.connector_slug}, ${gap.environment})`;
  if (gap.reason === "disabled")
    return `${subject} is disabled, so no automated run can use it. Enable it in Cockpit under Connectors, then review again.`;
  if (gap.reason === "needs_reauth")
    return `${subject} must be signed in again before an automated run can use it. Open its credentials in Cockpit and sign in again, then review again.`;
  return `${subject} has no stored credential, so no automated run in ${gap.environment} can use it. Store it with \`${vaultAttachCommand(gap)}\` (the secret on stdin), or open the connector's credentials in Cockpit, then review again.`;
}

export function connectorGapGuidance(
  diagnoses: ReadonlyArray<{
    code: string;
    subject: { step_id: string };
    evidence: { connector?: ConnectorGap };
  }>,
): Array<{ step_id: string; code: "connector_unavailable"; instruction: string }> {
  return diagnoses.flatMap((entry) =>
    entry.code === "connector_unavailable" && entry.evidence.connector
      ? [
          {
            step_id: entry.subject.step_id,
            code: "connector_unavailable" as const,
            instruction: connectorGapInstruction(entry.evidence.connector),
          },
        ]
      : [],
  );
}
