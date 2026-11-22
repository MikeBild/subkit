import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../config/loader.ts";
import {
  conversations,
  executions,
  hostedWorkAdmissions,
  mcpTasks,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { tenantWorkSnapshot } from "../execution/tenant-work.ts";
import { createOpenApiApp } from "../http/openapi.ts";
import { registerHostedWorkRoutes } from "../http/routes/hosted-work.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { provisionTestWorkspace } from "../test-helpers/workspace-registration.ts";
import { createBoss, disposeBoss } from "./boss.ts";
import {
  enqueueHostedWork,
  HostedWorkQuotaError,
  listUnsettledHostedWork,
  releaseStoppedPendingHostedWork,
  withHostedWork,
} from "./hosted-work.ts";
import { reconcileHostedWorkAfterReviewedOwnerStop } from "./hosted-work-reconciliation.ts";
import { queuedSendTransaction } from "./transaction-adapter.ts";

let tdb: TestDb;
let boss: PgBoss;
let dir: string;
let sequence = 0;
let operatorTenantId: string;
const uuid = createDeterministicUuidFactory(0xaad112);
const QUEUE = "chat.event";
beforeAll(async () => {
  tdb = await createTestDb("hosted-work");
  const [operator] = await tdb.db
    .insert(tenants)
    .values({ slug: "hosted-work-operator", display_name: "Operator", is_operator: true })
    .returning();
  if (!operator) throw new Error("missing operator");
  operatorTenantId = operator.id;
  boss = await createBoss({ connectionString: tdb.url });
  await boss.createQueue(QUEUE);
  dir = mkdtempSync(join(tmpdir(), "subkit-hosted-work-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(dir, "seed.json"),
  });
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  await setConfigKey("queue.hosted.execution_concurrency", 1);
  await setConfigKey("queue.hosted.chat_concurrency", 1);
  await setConfigKey("queue.hosted.pending_jobs", 1);
});
afterAll(async () => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
  await disposeBoss(boss);
  await tdb.cleanup();
});
async function fixture() {
  sequence += 1;
  return (await provisionTestWorkspace(`work-${sequence}`, tdb.db)).tenant.id;
}
function barrier() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test("real pg-boss public send adapter rolls queue job back with the product transaction", async () => {
  const id = uuid();
  await expect(queuedSendTransaction(tdb.db).executeSql("SELECT $10", ["[]"])).rejects.toThrow(
    "SQL contract",
  );
  await expect(
    tdb.db.transaction(async (tx) => {
      expect(await boss.send(QUEUE, { probe: true }, { id, db: queuedSendTransaction(tx) })).toBe(
        id,
      );
      throw new Error("rollback probe");
    }),
  ).rejects.toThrow("rollback probe");
  expect(await boss.findJobs(QUEUE, { id })).toHaveLength(0);
});
test("parallel admission enforces pending cap, exact-job replay and separate tenant grouping", async () => {
  const tenant = await fixture();
  const ids = [uuid(), uuid()];
  const results = await Promise.allSettled(
    ids.map((id) =>
      enqueueHostedWork(tdb.db, boss, "execution", QUEUE, { tenant_id: tenant }, { id }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const accepted = results.find((r) => r.status === "fulfilled");
  if (accepted?.status !== "fulfilled" || !accepted.value) throw new Error("missing accepted job");
  const id = accepted.value;
  expect(
    await enqueueHostedWork(tdb.db, boss, "execution", QUEUE, { tenant_id: tenant }, { id }),
  ).toBe(id);
  expect(await listUnsettledHostedWork(tenant, tdb.db)).toHaveLength(1);
  expect((await boss.findJobs(QUEUE, { id }))[0]?.groupId).toBe(tenant);
  const other = await fixture();
  expect(
    await enqueueHostedWork(tdb.db, boss, "execution", QUEUE, { tenant_id: other }),
  ).toBeString();
});
test("active quota is atomic, tenant/kind isolated and recursive work shares the admission", async () => {
  const tenant = await fixture();
  const entered = barrier();
  const stop = barrier();
  const first = withHostedWork(tdb.db, tenant, "execution", async () => {
    await withHostedWork(tdb.db, tenant, "execution", async () => 1);
    entered.release();
    await stop.promise;
  });
  await entered.promise;
  await expect(withHostedWork(tdb.db, tenant, "execution", async () => 2)).rejects.toBeInstanceOf(
    HostedWorkQuotaError,
  );
  await expect(withHostedWork(tdb.db, tenant, "chat", async () => 3)).resolves.toBe(3);
  await expect(withHostedWork(tdb.db, await fixture(), "execution", async () => 4)).resolves.toBe(
    4,
  );
  expect(await listUnsettledHostedWork(tenant, tdb.db)).toHaveLength(1);
  stop.release();
  await first;
  expect(await listUnsettledHostedWork(tenant, tdb.db)).toHaveLength(0);
});
test("caller timeout or abort does not release a still-running producer", async () => {
  const tenant = await fixture();
  const entered = barrier();
  const stop = barrier();
  const controller = new AbortController();
  const actual = withHostedWork(tdb.db, tenant, "chat", async () => {
    entered.release();
    await stop.promise;
    return controller.signal.aborted;
  });
  await entered.promise;
  controller.abort();
  expect(
    await Promise.race([actual.then(() => "settled"), Promise.resolve("caller timeout")]),
  ).toBe("caller timeout");
  await expect(withHostedWork(tdb.db, tenant, "chat", async () => 0)).rejects.toBeInstanceOf(
    HostedWorkQuotaError,
  );
  stop.release();
  expect(await actual).toBe(true);
  expect(await listUnsettledHostedWork(tenant, tdb.db)).toHaveLength(0);
});
test("queued failure returns pending only after the attempt settles, then permits retry", async () => {
  const tenant = await fixture();
  const id = await enqueueHostedWork(tdb.db, boss, "execution", QUEUE, { tenant_id: tenant });
  if (!id) throw new Error("missing job");
  await expect(
    withHostedWork(
      tdb.db,
      tenant,
      "execution",
      async () => {
        throw new Error("retry");
      },
      { queue: QUEUE, id },
    ),
  ).rejects.toThrow("retry");
  expect((await listUnsettledHostedWork(tenant, tdb.db))[0]?.state).toBe("pending");
  await withHostedWork(tdb.db, tenant, "execution", async () => 1, { queue: QUEUE, id });
  await expect(
    withHostedWork(tdb.db, tenant, "execution", async () => 2, { queue: QUEUE, id }),
  ).rejects.toThrow("no pending admission");
});
test("legacy unadmitted jobs and stranded active records fail closed without timeout expiry", async () => {
  const tenant = await fixture();
  await expect(
    withHostedWork(tdb.db, tenant, "execution", async () => 1, { queue: QUEUE, id: uuid() }),
  ).rejects.toThrow("no pending admission");
  await tdb.db
    .insert(hostedWorkAdmissions)
    .values({ tenant_id: tenant, kind: "execution", state: "active", owner_boot_id: uuid() });
  await expect(withHostedWork(tdb.db, tenant, "execution", async () => 2)).rejects.toThrow(
    "unresolved work",
  );
  expect(await releaseStoppedPendingHostedWork(tenant, boss, tdb.db)).toBe(0);
});
test("terminal queue cleanup releases only pending and workers reject already-released claims", async () => {
  const tenant = await fixture();
  const id = await enqueueHostedWork(tdb.db, boss, "chat", QUEUE, { tenant_id: tenant });
  if (!id) throw new Error("missing job");
  expect(await releaseStoppedPendingHostedWork(tenant, boss, tdb.db)).toBe(0);
  await boss.cancel(QUEUE, id);
  expect(await releaseStoppedPendingHostedWork(tenant, boss, tdb.db)).toBe(1);
  await expect(
    withHostedWork(tdb.db, tenant, "chat", async () => 1, { queue: QUEUE, id }),
  ).rejects.toThrow("no pending admission");
});
test("missing policies deny hosted work even when registration is off; selfhost stays unrestricted", async () => {
  const tenant = await fixture();
  await setConfigKey("queue.hosted.pending_jobs", 0);
  await expect(withHostedWork(tdb.db, tenant, "chat", async () => 1)).rejects.toThrow(
    "not configured",
  );
  await expect(
    enqueueHostedWork(tdb.db, boss, "chat", QUEUE, { tenant_id: tenant }),
  ).rejects.toThrow("not configured");
  const [selfhost] = await tdb.db
    .insert(tenants)
    .values({ slug: `work-selfhost-${sequence}`, display_name: "Selfhost" })
    .returning();
  if (!selfhost) throw new Error("missing tenant");
  await expect(withHostedWork(tdb.db, selfhost.id, "execution", async () => 5)).resolves.toBe(5);
  expect(
    await tdb.db
      .select()
      .from(hostedWorkAdmissions)
      .where(and(eq(hostedWorkAdmissions.tenant_id, selfhost.id))),
  ).toHaveLength(0);
  await setConfigKey("queue.hosted.pending_jobs", 1);
});

test("public SDK worker grouping gives another tenant capacity while the first tenant is busy", async () => {
  const queue = "execution.run";
  await boss.createQueue(queue);
  await setConfigKey("queue.hosted.pending_jobs", 2);
  const tenant = await fixture();
  const other = await fixture();
  const stop = barrier();
  const entered = barrier();
  const seen: string[] = [];
  await boss.work<{ tenant_id: string; marker: string }>(
    queue,
    { batchSize: 1, localConcurrency: 2, groupConcurrency: 1, pollingIntervalSeconds: 0.5 },
    async (jobs) => {
      for (const job of jobs)
        await withHostedWork(
          tdb.db,
          job.data.tenant_id,
          "execution",
          async () => {
            seen.push(job.data.marker);
            if (job.data.marker === "first") {
              entered.release();
              await stop.promise;
            }
          },
          { queue, id: job.id },
        );
    },
  );
  await enqueueHostedWork(tdb.db, boss, "execution", queue, { tenant_id: tenant, marker: "first" });
  await entered.promise;
  await enqueueHostedWork(tdb.db, boss, "execution", queue, {
    tenant_id: tenant,
    marker: "second",
  });
  await enqueueHostedWork(tdb.db, boss, "execution", queue, { tenant_id: other, marker: "other" });
  try {
    await waitFor(() => seen.includes("other"), {
      tries: 100,
      sleepMs: 50,
      label: "other tenant progresses",
    });
    expect(seen).toEqual(["first", "other"]);
  } finally {
    stop.release();
  }
  await waitFor(() => seen.includes("second"), {
    tries: 100,
    sleepMs: 50,
    label: "same tenant resumes",
  });
  await waitFor(async () => (await listUnsettledHostedWork(tenant, tdb.db)).length === 0, {
    tries: 100,
    sleepMs: 50,
    label: "worker settled",
  });
  await boss.offWork(queue);
  await setConfigKey("queue.hosted.pending_jobs", 1);
});
test("reconciliation requires operator browser review, exact owner and content evidence, never current-process work", async () => {
  const tenant = await fixture();
  const session = uuid();
  const principal: ResolvedPrincipal = {
    kind: "user",
    provider: "browser_session",
    tenant_id: operatorTenantId,
    id: uuid(),
    session_id: session,
    auth_source: { kind: "browser_session", session_id: session },
    roles: ["admin"],
  };
  const owner = uuid();
  const [row] = await tdb.db
    .insert(hostedWorkAdmissions)
    .values({ tenant_id: tenant, kind: "execution", state: "active", owner_boot_id: owner })
    .returning();
  if (!row) throw new Error("missing work");
  const review = {
    admission_id: row.id,
    owner_boot_id: owner,
    reviewed_owner_stop_evidence:
      "The operator reviewed the instance shutdown acknowledgement, verified all child workers exited and checked that no replacement owner can continue this admission.",
    all_work_from_owner_stopped: true as const,
  };
  await expect(
    reconcileHostedWorkAfterReviewedOwnerStop(
      tdb.db,
      tenant,
      {
        ...principal,
        auth_source: { kind: "api_key", api_key_id: uuid(), credential_version: "digest" },
      },
      review,
    ),
  ).rejects.toThrow("browser review");
  await expect(
    reconcileHostedWorkAfterReviewedOwnerStop(
      tdb.db,
      tenant,
      { ...principal, tenant_id: tenant },
      review,
    ),
  ).rejects.toThrow("browser review");
  await expect(
    reconcileHostedWorkAfterReviewedOwnerStop(tdb.db, tenant, principal, {
      ...review,
      reviewed_owner_stop_evidence: "a".repeat(64),
    }),
  ).rejects.toThrow();
  await expect(
    reconcileHostedWorkAfterReviewedOwnerStop(tdb.db, tenant, principal, {
      ...review,
      owner_boot_id: uuid(),
    }),
  ).rejects.toThrow("does not match");
  await expect(
    reconcileHostedWorkAfterReviewedOwnerStop(tdb.db, await fixture(), principal, review),
  ).rejects.toThrow("does not match");
  await reconcileHostedWorkAfterReviewedOwnerStop(tdb.db, tenant, principal, review);
  const [saved] = await tdb.db
    .select()
    .from(hostedWorkAdmissions)
    .where(and(eq(hostedWorkAdmissions.tenant_id, tenant), eq(hostedWorkAdmissions.id, row.id)));
  expect(saved?.state).toBe("released");
  expect(saved?.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
  const [current] = await tdb.db
    .insert(hostedWorkAdmissions)
    .values({
      tenant_id: tenant,
      kind: "chat",
      state: "active",
      owner_boot_id: tenantWorkSnapshot(tenant).boot_id,
    })
    .returning();
  if (!current) throw new Error("missing work");
  await expect(
    reconcileHostedWorkAfterReviewedOwnerStop(tdb.db, tenant, principal, {
      ...review,
      admission_id: current.id,
      owner_boot_id: current.owner_boot_id,
    }),
  ).rejects.toThrow("running process");
});

test("operator review HTTP boundary rejects bearer authority, scopes reads and refuses stale replay", async () => {
  const tenant = await fixture();
  const neighbor = await fixture();
  const session = uuid();
  let principal: ResolvedPrincipal = {
    kind: "user",
    provider: "browser_session",
    tenant_id: operatorTenantId,
    id: uuid(),
    session_id: session,
    auth_source: { kind: "browser_session", session_id: session },
    roles: ["admin"],
  };
  const app = createOpenApiApp();
  app.use("*", async (c, next) => {
    c.set("db", tdb.db);
    c.set("principal", principal);
    await next();
  });
  registerHostedWorkRoutes(app);
  const [row, other] = await tdb.db
    .insert(hostedWorkAdmissions)
    .values([
      { tenant_id: tenant, kind: "chat", state: "active", owner_boot_id: uuid() },
      { tenant_id: neighbor, kind: "execution", state: "active", owner_boot_id: uuid() },
    ])
    .returning();
  if (!row || !other) throw new Error("missing work");
  const path = `/v1/settings/hosted-work/${tenant}`;
  const review = {
    admission_id: row.id,
    owner_boot_id: row.owner_boot_id,
    reviewed_owner_stop_evidence:
      "A human checked the complete process stop acknowledgement and verified that every child producer exited before reviewing this exact owner and admission for release.",
    all_work_from_owner_stopped: true,
  };
  const post = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  principal = {
    ...principal,
    auth_source: { kind: "api_key", api_key_id: uuid(), credential_version: "digest" },
  };
  expect((await app.request(path)).status).toBe(403);
  expect((await post(review)).status).toBe(403);
  principal = { ...principal, auth_source: { kind: "browser_session", session_id: session } };
  const listed = await app.request(path);
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as { items: { admission_id: string }[]; has_more: boolean };
  expect(body.items.map((item) => item.admission_id)).toEqual([row.id]);
  expect(body.has_more).toBe(false);
  expect((await post({ ...review, all_work_from_owner_stopped: false })).status).toBe(400);
  expect(
    (await post({ ...review, admission_id: other.id, owner_boot_id: other.owner_boot_id })).status,
  ).toBe(409);
  const released = await post(review);
  expect(released.status).toBe(200);
  expect(await released.json()).toMatchObject({
    admission_id: row.id,
    state: "released",
    evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect((await post(review)).status).toBe(409);
  expect(await (await app.request(path)).json()).toEqual({ items: [], has_more: false });
  const [untouched] = await tdb.db
    .select()
    .from(hostedWorkAdmissions)
    .where(
      and(eq(hostedWorkAdmissions.tenant_id, neighbor), eq(hostedWorkAdmissions.id, other.id)),
    );
  expect(untouched?.state).toBe("active");
});

test("unawaited nested producers retain the shared admission until they actually settle", async () => {
  const tenant = await fixture();
  const entered = barrier();
  const stop = barrier();
  const parent = withHostedWork(tdb.db, tenant, "chat", async () => {
    void withHostedWork(tdb.db, tenant, "chat", async () => {
      entered.release();
      await stop.promise;
    });
    await entered.promise;
  });
  await entered.promise;
  expect(await Promise.race([parent.then(() => "settled"), Promise.resolve("held")])).toBe("held");
  await expect(withHostedWork(tdb.db, tenant, "chat", async () => 0)).rejects.toThrow(
    "quota is exhausted",
  );
  stop.release();
  await parent;
  expect(await listUnsettledHostedWork(tenant, tdb.db)).toHaveLength(0);
});

test("public direct execution and chat entry points cannot bypass active hosted quotas", async () => {
  const tenant = await fixture();
  const { runExecution } = await import("../execution/engine.ts");
  const { runLoop } = await import("../conversations/loop/index.ts");
  await tdb.db.insert(hostedWorkAdmissions).values([
    { tenant_id: tenant, kind: "execution", state: "active", owner_boot_id: uuid() },
    { tenant_id: tenant, kind: "chat", state: "active", owner_boot_id: uuid() },
  ]);
  await expect(
    runExecution({
      db: tdb.db,
      tenant_id: tenant,
      source: { kind: "saved", workflow_id: uuid() },
      input: {},
    }),
  ).rejects.toBeInstanceOf(HostedWorkQuotaError);
  await expect(
    runLoop({
      db: tdb.db,
      tenant_id: tenant,
      conversation_id: uuid(),
      actor_id: uuid(),
      connector_id: null,
      workflow_id: null,
      user_message: null,
      turn_abort_ctrl: new AbortController(),
    }),
  ).rejects.toBeInstanceOf(HostedWorkQuotaError);
});

test("real chat and execution workers persist an explicit quota denial instead of leaving accepted tasks hanging", async () => {
  const { registerExecutionRunHandler } = await import("./handlers/execution-run.ts");
  const { enqueueConversationRunTurn, registerConversationRunTurnHandler } = await import(
    "./handlers/conversation-run-turn.ts"
  );
  const { EXECUTION_RUN_QUEUE, CONVERSATION_RUN_TURN_QUEUE } = await import("./queues.ts");
  const executionTenant = await fixture();
  const chatTenant = await fixture();
  await tdb.db.insert(hostedWorkAdmissions).values([
    { tenant_id: executionTenant, kind: "execution", state: "active", owner_boot_id: uuid() },
    { tenant_id: chatTenant, kind: "chat", state: "active", owner_boot_id: uuid() },
  ]);
  const [execution] = await tdb.db
    .insert(executions)
    .values({
      tenant_id: executionTenant,
      status: "queued",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning();
  const [conversation] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: chatTenant, status: "active" })
    .returning();
  if (!execution || !conversation) throw new Error("missing fixture");
  const id = uuid();
  const [task] = await tdb.db
    .insert(mcpTasks)
    .values({
      tenant_id: chatTenant,
      conversation_id: conversation.id,
      kind: "start",
      turn_seq: 1,
      job_id: id,
    })
    .returning();
  if (!task) throw new Error("missing task");
  await enqueueHostedWork(
    tdb.db,
    boss,
    "execution",
    EXECUTION_RUN_QUEUE,
    { tenant_id: executionTenant, execution_id: execution.id, workflow_id: uuid() },
    { id: execution.id },
  );
  await enqueueConversationRunTurn(
    boss,
    tdb.db,
    {
      tenant_id: chatTenant,
      conversation_id: conversation.id,
      mcp_task_id: task.id,
      actor_id: null,
      kind: "start",
    },
    { id },
  );
  await registerExecutionRunHandler({ boss, db: tdb.db });
  await registerConversationRunTurnHandler({ boss, db: tdb.db });
  try {
    await waitFor(
      async () => {
        const [result] = await tdb.db
          .select()
          .from(mcpTasks)
          .where(and(eq(mcpTasks.tenant_id, chatTenant), eq(mcpTasks.id, task.id)));
        return result?.failure_reason === "hosted_work_quota_exhausted";
      },
      { tries: 100, sleepMs: 50, label: "chat admission denial is persisted" },
    );
    await waitFor(
      async () => {
        const [result] = await tdb.db
          .select()
          .from(executions)
          .where(and(eq(executions.tenant_id, executionTenant), eq(executions.id, execution.id)));
        return (
          result?.status === "failed" &&
          result.failure?.error_code === "hosted_work_quota_exhausted"
        );
      },
      { tries: 100, sleepMs: 50, label: "execution admission denial is persisted" },
    );
  } finally {
    await boss.offWork(EXECUTION_RUN_QUEUE);
    await boss.offWork(CONVERSATION_RUN_TURN_QUEUE);
  }
});
