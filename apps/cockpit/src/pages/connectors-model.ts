export interface WorkflowUsingConnectors {
  id: string;
  name: string;
  connectors: string[];
}

/**
 * Inverts `workflow.connectors[]` into "which workflows reach this connector".
 *
 * The engine answers "which connectors does this workflow use" per workflow;
 * the connector list needs the other direction. One `/v1/workflows` read is
 * inverted client-side rather than one request per row.
 */
export function workflowsByConnector(
  workflows: readonly WorkflowUsingConnectors[],
): Map<string, WorkflowUsingConnectors[]> {
  const byConnector = new Map<string, WorkflowUsingConnectors[]>();
  for (const workflow of workflows) {
    for (const slug of workflow.connectors) {
      const current = byConnector.get(slug);
      if (current) current.push(workflow);
      else byConnector.set(slug, [workflow]);
    }
  }
  return byConnector;
}

/** The one narrowing a link can put on the connector list: `?health=not_ok`. */
export type ConnectorHealthFilter = "not_ok";

export function connectorHealthFilterFromUrl(search: string): ConnectorHealthFilter | null {
  return new URLSearchParams(search).get("health") === "not_ok" ? "not_ok" : null;
}

/**
 * Whether a connector counts against the installation's health.
 *
 * The engine's own predicate, not a second opinion: the connector-health ratio
 * divides the healthy by every ENABLED connector, and "healthy" is
 * `health_state = 'ok'` (operator/operational-overview.ts). So the list a red
 * connector tile opens is exactly the complement of that numerator — enabled
 * and anything but `ok`. A disabled connector is not in the ratio at all, and
 * `needs_reauth` is not consulted on its own: the engine writes the same fact
 * into `health_state`, and reading both could list a connector the ratio does
 * not count.
 */
export function connectorNeedsAttention(connector: {
  enabled?: unknown;
  health_state?: unknown;
}): boolean {
  return connector.enabled === true && connector.health_state !== "ok";
}
