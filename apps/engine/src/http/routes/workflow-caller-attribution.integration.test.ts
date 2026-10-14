import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, systemAccounts, workflows } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;
let machineKey: string;

beforeAll(async () => {
  server = await createHttpTestServer("workflow-caller-attribution");
  await server.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(server.db, "admin") })
    .where(eq(systemAccounts.id, server.systemAccountId));
  machineKey = "wf_live_SYS_workflow_caller_attribution_000";
  await server.db.insert(apiKeys).values({
    tenant_id: server.tenantId,
    system_account_id: server.systemAccountId,
    prefix: machineKey.slice(0, 12),
    token_sha256: createHash("sha256").update(machineKey).digest("hex"),
    scopes: ["*"],
  });
});

afterAll(async () => {
  await server.cleanup();
});

function api(path: string, init: RequestInit = {}, key = server.apiKey): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

async function workflow(slug: string) {
  const [row] = await server.db
    .insert(workflows)
    .values({
      tenant_id: server.tenantId,
      slug,
      name: slug,
      lifecycle: "active",
      is_tool: false,
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("workflow fixture insert returned no row");
  return row.id;
}

async function expectActor(
  action: string,
  resourceId: string,
  actor_type: string,
  actor_id: string,
) {
  const [audit] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resourceId),
      ),
    );
  expect(audit).toEqual({ actor_type, actor_id });
}

test("workflow metadata, deletion, and schedule CRUD preserve authenticated actor kind", async () => {
  for (const actor of [
    { kind: "user", key: server.apiKey, id: server.userId },
    { kind: "system_account", key: machineKey, id: server.systemAccountId },
  ]) {
    const metadataWorkflowId = await workflow(`caller-meta-${actor.kind}`);
    const metadata = await api(
      `/v1/workflows/${metadataWorkflowId}/metadata`,
      { method: "PATCH", body: JSON.stringify({ name: `Metadata ${actor.kind}` }) },
      actor.key,
    );
    expect(metadata.status).toBe(200);
    await expectActor("workflow.updated", metadataWorkflowId, actor.kind, actor.id);

    const deleteWorkflowId = await workflow(`caller-delete-${actor.kind}`);
    const deleted = await api(`/v1/workflows/${deleteWorkflowId}`, { method: "DELETE" }, actor.key);
    expect(deleted.status).toBe(204);
    await expectActor("workflow.deleted", deleteWorkflowId, actor.kind, actor.id);

    const scheduleWorkflowId = await workflow(`caller-schedule-${actor.kind}`);
    const created = await api(
      "/v1/schedules",
      {
        method: "POST",
        body: JSON.stringify({ workflow_id: scheduleWorkflowId, cron: "0 9 * * *" }),
      },
      actor.key,
    );
    expect(created.status).toBe(201);
    const createdSchedule = (await created.json()) as { id: string };
    await expectActor("schedule.created", createdSchedule.id, actor.kind, actor.id);

    const updated = await api(
      `/v1/schedules/${createdSchedule.id}`,
      { method: "PUT", body: JSON.stringify({ paused: true }) },
      actor.key,
    );
    expect(updated.status).toBe(200);
    await expectActor("schedule.updated", createdSchedule.id, actor.kind, actor.id);

    const scheduleDeleted = await api(
      `/v1/schedules/${createdSchedule.id}`,
      { method: "DELETE" },
      actor.key,
    );
    expect(scheduleDeleted.status).toBe(200);
    await expectActor("schedule.deleted", createdSchedule.id, actor.kind, actor.id);
  }
});
