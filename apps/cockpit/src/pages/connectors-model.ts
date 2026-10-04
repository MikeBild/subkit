export interface WorkflowUsingConnectors {
  id: string;
  name: string;
  connectors: string[];
}

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

export type ConnectorHealthFilter = "not_ok";

export function connectorHealthFilterFromUrl(search: string): ConnectorHealthFilter | null {
  return new URLSearchParams(search).get("health") === "not_ok" ? "not_ok" : null;
}
