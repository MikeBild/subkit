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

/**
 * The one narrowing a link can put on the connector list: `?health=not_ok`.
 * The engine answers it (`GET /v1/connectors?health=not_ok`) with the predicate
 * the connector-health ratio counts against; this page only carries it.
 */
export type ConnectorHealthFilter = "not_ok";

export function connectorHealthFilterFromUrl(search: string): ConnectorHealthFilter | null {
  return new URLSearchParams(search).get("health") === "not_ok" ? "not_ok" : null;
}
