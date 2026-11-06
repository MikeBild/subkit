import { and, eq } from "drizzle-orm";
import { connectorEnvironmentKey, getConnectorsForEnvironments } from "../connectors/service.ts";
import type { Executor } from "../db/client.ts";
import {
  webhooksInbound,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";

type ExecutionEnvironment = "dev" | "prod";

type ReviewEnvironmentSource = "schedule" | "hook" | "bindings" | "default";

export async function workflowExecutionEnvironment(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<ExecutionEnvironment> {
  const [workflow] = await db
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)))
    .limit(1);
  return (
    await resolveWorkflowReviewEnvironment(db, tenant_id, workflow_id, {
      version_id: workflow?.current_version_id ?? null,
    })
  ).environment;
}

export async function resolveWorkflowReviewEnvironment(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  { version_id }: { version_id: string | null },
): Promise<{ environment: ExecutionEnvironment; source: ReviewEnvironmentSource }> {
  const triggered = await triggerEnvironment(db, tenant_id, workflow_id);
  if (triggered) return triggered;
  const bound = version_id
    ? await bindingEnvironment(db, tenant_id, workflow_id, version_id)
    : null;
  return bound
    ? { environment: bound, source: "bindings" }
    : { environment: "dev", source: "default" };
}

async function bindingEnvironment(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  version_id: string,
): Promise<ExecutionEnvironment | null> {
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, workflow_id),
        eq(workflowVersions.id, version_id),
      ),
    )
    .limit(1);
  const steps = (version?.dag as { steps?: unknown } | undefined)?.steps;
  const connector_ids = [
    ...new Set(
      (Array.isArray(steps) ? steps : []).flatMap((step) =>
        step &&
        typeof step === "object" &&
        (step as { kind?: unknown }).kind === "request" &&
        typeof (step as { connector_id?: unknown }).connector_id === "string"
          ? [(step as { connector_id: string }).connector_id]
          : [],
      ),
    ),
  ];
  if (connector_ids.length === 0) return null;
  const environments = ["dev", "prod"] as const;
  const rows = await getConnectorsForEnvironments(
    tenant_id,
    environments.flatMap((environment) =>
      connector_ids.map((connector_id) => ({ connector_id, environment })),
    ),
    db,
  );
  const satisfiable = environments.filter((environment) =>
    connector_ids.every(
      (connector_id) =>
        rows.get(connectorEnvironmentKey(connector_id, environment))?.environment === environment,
    ),
  );
  return satisfiable.length === 1 ? (satisfiable[0] ?? null) : null;
}

async function triggerEnvironment(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<{ environment: ExecutionEnvironment; source: "schedule" | "hook" } | null> {
  const schedules = await db
    .select({ environment: workflowsSchedules.execution_mode })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
        eq(workflowsSchedules.paused, false),
      ),
    );
  const [hook] = await db
    .select({ id: webhooksInbound.id })
    .from(webhooksInbound)
    .where(
      and(
        eq(webhooksInbound.tenant_id, tenant_id),
        eq(webhooksInbound.workflow_id, workflow_id),
        eq(webhooksInbound.active, true),
      ),
    )
    .limit(1);
  const environments = [
    ...new Set<ExecutionEnvironment>([
      ...schedules.map((schedule) => schedule.environment),
      ...(hook ? (["prod"] as const) : []),
    ]),
  ];
  if (environments.length > 1)
    throw Object.assign(
      new Error(
        "This workflow is started in multiple environments. Choose the intended environment before preparing a run.",
      ),
      { code: "workflow_environment_ambiguous" },
    );
  const environment = environments[0];
  if (!environment) return null;
  return {
    environment,
    source: schedules.some((schedule) => schedule.environment === environment)
      ? "schedule"
      : "hook",
  };
}
