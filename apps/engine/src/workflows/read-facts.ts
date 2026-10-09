import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  type ConnectorSystem,
  connectorSystemKey,
  loadConnectorSystems,
} from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { workflowExecutionAuthorities, workflows, workflowVersions } from "../db/schema/index.ts";
import { authorityLive } from "./authority-live.ts";
import { loadWorkflowHistoryFacts, type WorkflowHistoryFacts } from "./history-read-facts.ts";
import { WorkflowDefSchema } from "./types.ts";

type WorkflowRow = typeof workflows.$inferSelect;
type VersionRow = typeof workflowVersions.$inferSelect;
type AuthorityRow = typeof workflowExecutionAuthorities.$inferSelect;

export interface WorkflowReadFacts {
  tenant_id: string;
  workflows: ReadonlyMap<string, WorkflowRow>;
  versions: ReadonlyMap<string, VersionRow>;
  connectors: ReadonlyMap<string, ConnectorSystem | null>;
  liveAuthorities: readonly AuthorityRow[];
  history: WorkflowHistoryFacts;
}

export function factVersion(facts: WorkflowReadFacts, workflow_id: string, version_id: string) {
  const workflow = facts.workflows.get(workflow_id);
  const version = facts.versions.get(version_id);
  return workflow && version?.workflow_id === workflow_id ? version : undefined;
}

export function factConnector(
  facts: WorkflowReadFacts,
  connector_id: string,
  environment: "dev" | "prod",
) {
  return facts.connectors.get(connectorSystemKey(connector_id, environment)) ?? null;
}

export async function loadWorkflowReadFacts(
  db: Executor,
  tenant_id: string,
  workflowIds: readonly string[],
  authorities: readonly AuthorityRow[],
): Promise<WorkflowReadFacts> {
  const ids = [...new Set(workflowIds)];
  const rows = ids.length
    ? await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, tenant_id),
            inArray(workflows.id, ids),
            isNull(workflows.deleted_at),
          ),
        )
    : [];
  const versionIds = [
    ...new Set([
      ...rows.flatMap((row) =>
        [row.current_version_id, row.draft_version_id].filter((id): id is string => id !== null),
      ),
      ...authorities
        .filter((row) => row.tenant_id === tenant_id && ids.includes(row.workflow_id))
        .map((row) => row.workflow_version_id),
    ]),
  ];
  const versions = versionIds.length
    ? await db
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, tenant_id),
            inArray(workflowVersions.workflow_id, ids),
            inArray(workflowVersions.id, versionIds),
          ),
        )
    : [];
  const calls = versions.flatMap((row) => {
    const parsed = WorkflowDefSchema.safeParse(row.dag);
    return parsed.success ? parsed.data.steps.filter((step) => step.kind === "call") : [];
  });
  const callIds = [
    ...new Set(calls.flatMap((step) => (step.workflow_id ? [step.workflow_id] : []))),
  ];
  const callSlugs = [
    ...new Set(calls.flatMap((step) => (step.workflow_slug ? [step.workflow_slug] : []))),
  ];
  const called =
    callIds.length || callSlugs.length
      ? await db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.tenant_id, tenant_id),
              eq(workflows.lifecycle, "active"),
              isNull(workflows.deleted_at),
              or(
                ...(callIds.length ? [inArray(workflows.id, callIds)] : []),
                ...(callSlugs.length ? [inArray(workflows.slug, callSlugs)] : []),
              ),
            ),
          )
      : [];
  const calledVersionIds = [
    ...new Set(called.flatMap((row) => (row.current_version_id ? [row.current_version_id] : []))),
  ];
  const calledVersions = calledVersionIds.length
    ? await db
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, tenant_id),
            inArray(
              workflowVersions.workflow_id,
              called.map((row) => row.id),
            ),
            inArray(workflowVersions.id, calledVersionIds),
          ),
        )
    : [];
  const allWorkflows = new Map([...rows, ...called].map((row) => [row.id, row]));
  const allVersions = new Map([...versions, ...calledVersions].map((row) => [row.id, row]));
  const connectorIds = new Set<string>();
  const stepIdsByWorkflow = new Map<string, string[]>();
  for (const row of allVersions.values()) {
    const parsed = WorkflowDefSchema.safeParse(row.dag);
    if (!parsed.success) continue;
    for (const step of parsed.data.steps) {
      stepIdsByWorkflow.set(row.workflow_id, [
        ...new Set([...(stepIdsByWorkflow.get(row.workflow_id) ?? []), step.id]),
      ]);
      if (step.kind === "request" && step.connector_id) connectorIds.add(step.connector_id);
    }
  }
  const [systems, liveAuthorities, history] = await Promise.all([
    loadConnectorSystems(
      tenant_id,
      [...connectorIds].flatMap((connector_id) => [
        { connector_id, environment: "dev" as const },
        { connector_id, environment: "prod" as const },
      ]),
      db,
    ),
    ids.length
      ? db
          .select()
          .from(workflowExecutionAuthorities)
          .where(
            and(
              eq(workflowExecutionAuthorities.tenant_id, tenant_id),
              inArray(workflowExecutionAuthorities.workflow_id, ids),
              authorityLive(),
            ),
          )
      : [],
    loadWorkflowHistoryFacts(
      db,
      tenant_id,
      [...allWorkflows.keys()],
      stepIdsByWorkflow,
      new Set(allVersions.keys()),
    ),
  ]);
  return {
    tenant_id,
    workflows: allWorkflows,
    versions: allVersions,
    connectors: systems,
    liveAuthorities,
    history,
  };
}
