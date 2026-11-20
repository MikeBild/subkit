import { beforeAll, describe, expect, test } from "bun:test";
import { auditAwait } from "../audit.ts";
import { type AuditQueryFilters, queryAuditLog, searchAuditResources } from "../query.ts";
import { AuditAction, type AuditEntry } from "../types.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb, uuid } from "./contracts-fixtures.ts";

useAuditContractsDb();

const TASK = uuid();
const OTHER_TASK = uuid();
const RUN = uuid();
const OTHER_RUN = uuid();
const GRANT = uuid();
const ids: Record<string, string> = {};

async function seed(name: string, entry: Partial<AuditEntry>, tenant = tenantA): Promise<void> {
  const written = await auditAwait(
    { tenant_id: tenant, action: AuditAction.TASK_UPDATED, resource_type: "task", ...entry },
    testDb.db,
  );
  ids[name] = written.id;
}

async function namesFor(filters: Omit<AuditQueryFilters, "tenant_id">, tenant = tenantA) {
  const page = await queryAuditLog(testDb.db, { tenant_id: tenant, ...filters }, { limit: 500 });
  const names = Object.entries(ids)
    .filter(([, id]) => page.items.some((item) => item.id === id))
    .map(([name]) => name);
  expect(names.length).toBe(page.items.length);
  return names.sort();
}

beforeAll(async () => {
  await seed("task_created", {
    action: AuditAction.TASK_CREATED,
    resource_id: TASK,
    after: { name: "Weekly revenue report" },
  });
  await seed("task_renamed", {
    resource_id: TASK,
    before: { name: "Weekly revenue report" },
    after: { name: "Monthly revenue report" },
  });
  await seed("grant", {
    action: AuditAction.TASK_AUTHORITY_GRANTED,
    resource_type: "task_grant",
    resource_id: GRANT,
    metadata: { task_id: TASK, task_grant_id: GRANT },
  });
  await seed("run_started", {
    action: AuditAction.TASK_RUN_STARTED,
    resource_type: "task_run",
    resource_id: RUN,
    metadata: { task_id: TASK },
  });
  await seed("run_tool_call", {
    action: AuditAction.EXECUTION_QUEUED,
    resource_type: "execution",
    resource_id: uuid(),
    metadata: { task_id: TASK, task_run_id: RUN },
  });
  await seed("other_run_started", {
    action: AuditAction.TASK_RUN_STARTED,
    resource_type: "task_run",
    resource_id: OTHER_RUN,
    metadata: { task_id: TASK },
  });
  await seed("run_id_on_wrong_type", { resource_type: "workflow", resource_id: RUN });
  await seed("other_task", { resource_id: OTHER_TASK, after: { name: "Inbox triage" } });
  await seed(
    "other_tenant",
    { resource_id: TASK, after: { name: "Weekly revenue report" } },
    tenantB,
  );
});

describe("audit filters for tasks", () => {
  test("task_id returns the task's own entries and every entry that references it", async () => {
    expect(await namesFor({ task_id: TASK })).toEqual([
      "grant",
      "other_run_started",
      "run_started",
      "run_tool_call",
      "task_created",
      "task_renamed",
    ]);
    expect(await namesFor({ task_id: OTHER_TASK })).toEqual(["other_task"]);
  });

  test("task_run_id returns one run's entries and never a row of another resource type", async () => {
    expect(await namesFor({ task_run_id: RUN })).toEqual(["run_started", "run_tool_call"]);
    expect(await namesFor({ task_run_id: OTHER_RUN })).toEqual(["other_run_started"]);
  });

  test("both filters stay inside the tenant", async () => {
    expect(await namesFor({ task_id: TASK }, tenantB)).toEqual(["other_tenant"]);
    expect(await namesFor({ task_run_id: RUN }, tenantB)).toEqual([]);
  });

  test("a task is found by its current and by an earlier recorded name", async () => {
    const current = await searchAuditResources(testDb.db, tenantA, "Monthly revenue");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      resource_type: "task",
      resource_id: TASK,
      resource_name: "Monthly revenue report",
    });
    const earlier = await searchAuditResources(testDb.db, tenantA, "weekly revenue", "task");
    expect(earlier.map((match) => match.resource_id)).toEqual([TASK]);
    expect(earlier[0]?.resource_name).toBe("Monthly revenue report");
    expect(await searchAuditResources(testDb.db, tenantA, "revenue", "workflow")).toEqual([]);
  });

  test("runs and grants are not listed as searchable resources", async () => {
    expect(await searchAuditResources(testDb.db, tenantA, GRANT)).toEqual([]);
    const byRunId = await searchAuditResources(testDb.db, tenantA, RUN);
    expect(byRunId.map((match) => match.resource_type)).toEqual(["workflow"]);
  });
});
