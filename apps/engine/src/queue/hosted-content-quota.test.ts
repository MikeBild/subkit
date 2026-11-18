import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { setConfigKey } from "../config/loader.ts";
import { createDbFromUrl } from "../db/client.ts";
import {
  auditLog,
  conversationMessages,
  conversations,
  events,
  executionSteps,
  executions,
  hostedTenantUsage,
  hostedWorkAdmissions,
  mcpTasks,
  sessions,
  users,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { authorizationContextFromPrincipal } from "../execution/authorization-context.ts";
import { callerFromPrincipal } from "../execution/caller-context.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import { logRing } from "../observability/log-ring.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { type EnvHandle, withTestEnv } from "../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { now } from "../utils/clock.ts";
import { createBoss, disposeBoss } from "./boss.ts";
import {
  enqueueConversationRunTurn,
  registerConversationRunTurnHandler,
} from "./handlers/conversation-run-turn.ts";
import { registerExecutionRunHandler } from "./handlers/execution-run.ts";
import { enqueueHostedWork } from "./hosted-work.ts";
import { CONVERSATION_RUN_TURN_QUEUE, EXECUTION_RUN_QUEUE } from "./queues.ts";

let fixture: TestDb;
let connection: ReturnType<typeof createDbFromUrl>;
let boss: PgBoss;
let env: EnvHandle;
const nextId = createDeterministicUuidFactory(9181);
const WORKER_ERROR_MESSAGES = new Set([
  "hosted_storage_quota_exhausted",
  "hosted_resource_count_exhausted",
  "hosted_quota_terminal_receipt_required",
  "hosted_quota_control_receipt_invalid",
  "hosted_quota_concurrent_write",
  "hosted_quota_requires_read_committed",
  "Workspace quota state changed concurrently; retry in a read committed transaction.",
]);

function safeWorkerError(value: unknown) {
  if (!value || typeof value !== "object") return { kind: typeof value };
  const message = Reflect.get(value, "message");
  const name = Reflect.get(value, "name");
  const code = Reflect.get(value, "code");
  const stack = Reflect.get(value, "stack");
  const message_category =
    typeof message !== "string"
      ? null
      : message === "hosted_quota_concurrent_write" ||
          message === "hosted_quota_requires_read_committed" ||
          message ===
            "Workspace quota state changed concurrently; retry in a read committed transaction." ||
          name === "HostedQuotaRetryError"
        ? "mapped_hosted_quota_retry"
        : message === "Catalog vocabulary stayed busy; retry the operation"
          ? "catalog_vocabulary_busy"
          : /serializ|concurrent update/i.test(message)
            ? "postgres_serialization_failure"
            : /deadlock/i.test(message)
              ? "postgres_deadlock"
              : "other";
  const stack_functions =
    typeof stack === "string"
      ? stack
          .split("\n")
          .map((line) => /^\s*at\s+([^\s(]+)/.exec(line)?.[1])
          .filter((name): name is string => Boolean(name))
          .slice(0, 8)
      : [];
  return {
    kind: "object",
    code: typeof code === "string" ? code : null,
    name: name === "HostedQuotaRetryError" ? name : null,
    message: typeof message === "string" && WORKER_ERROR_MESSAGES.has(message) ? message : null,
    message_category,
    has_message: typeof message === "string",
    stack_functions,
  };
}

function safeWorkerPhases(tenantId: string) {
  return logRing
    .tail({ limit: 200, visible_to_tenant: tenantId, include_engine: false })
    .map(({ level, module, action }) => ({
      level,
      module: module ?? null,
      action: action ?? null,
    }));
}

beforeAll(async () => {
  env = withTestEnv({ LLM_PROVIDER: "mock" });
  fixture = await createTestDb("hosted-content-quota-workers");
  await configureHostedPolicyForTests(fixture.db, fixture.url);
  connection = createDbFromUrl(fixture.url);
  for (const key of ["pending_jobs", "execution_concurrency", "chat_concurrency"])
    await setConfigKey(`queue.hosted.${key}`, 2);
  boss = await createBoss({ connectionString: fixture.url });
  await boss.createQueue(EXECUTION_RUN_QUEUE, { retryLimit: 0 });
  await boss.createQueue(CONVERSATION_RUN_TURN_QUEUE, { retryLimit: 0 });
});
afterAll(async () => {
  await disposeBoss(boss);
  await connection?.pool.end();
  await fixture?.cleanup();
  env?.restore();
});

test("accepted execution and conversation tasks terminate safely when shared content storage is exactly full", async () => {
  const db = connection.db;
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "content-quota-workers",
      email: "quota-workers@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    db,
  );
  const tenantId = owned.tenant.id;
  const [session] = await db
    .insert(sessions)
    .values({
      tenant_id: tenantId,
      user_id: owned.membership.user_id,
      auth_identity_id: owned.identity.id,
      expires_at: new Date(now() + 3600000),
      absolute_expires_at: new Date(now() + 3600000),
    })
    .returning();
  if (!session) throw new Error("browser fixture missing");
  const principal: ResolvedPrincipal = {
    kind: "user",
    id: owned.membership.user_id,
    tenant_id: tenantId,
    provider: "browser_session",
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  const [workflow] = await db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: "quota-worker",
      name: "Quota worker",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow fixture missing");
  const [version] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "Quota worker",
        steps: [
          {
            id: "result",
            kind: "transform",
            language: "javascript",
            expression: "return input.input;",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("version fixture missing");
  await db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflow.id)));
  const canary = "private-content-quota-worker-canary";
  const executionCorrelation = "a".repeat(32);
  const conversationCorrelation = "b".repeat(32);
  const [execution] = await db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      status: "queued",
      hold_writes: true,
      request_source: "api",
      origin_source: "ui",
      audit_trace_id: executionCorrelation,
      execution_mode: "dev",
      input: { private: canary },
      caller_context: callerFromPrincipal(principal, tenantId),
      authorization_context: authorizationContextFromPrincipal(principal),
    })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active", owner_id: principal.id })
    .returning();
  if (!execution || !conversation) throw new Error("accepted fixture missing");
  const [message] = await db
    .insert(conversationMessages)
    .values({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      role: "user",
      content: { text: canary },
    })
    .returning();
  if (!message) throw new Error("message fixture missing");
  getMockProvider().setConversePlan(conversation.id, [{ text: `Quota reply ${canary}` }]);
  const jobId = nextId();
  const [task] = await db
    .insert(mcpTasks)
    .values({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      kind: "start",
      turn_seq: 1,
      job_id: jobId,
      user_message_id: message.id,
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
      origin_source: "mcp",
      audit_trace_id: conversationCorrelation,
    })
    .returning();
  if (!task) throw new Error("accepted task missing");
  await enqueueHostedWork(
    db,
    boss,
    "execution",
    EXECUTION_RUN_QUEUE,
    { tenant_id: tenantId, execution_id: execution.id, workflow_id: workflow.id },
    { id: execution.id },
  );
  await enqueueConversationRunTurn(
    boss,
    db,
    {
      tenant_id: tenantId,
      conversation_id: conversation.id,
      mcp_task_id: task.id,
      actor_id: principal.id,
      principal,
      kind: "start",
    },
    { id: jobId },
  );
  const [baseline] = await db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!baseline) throw new Error("usage fixture missing");
  await db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${baseline.logical_bytes.toString()}::text)),'{storage,hosted,retained_rows_per_resource}',to_jsonb(${Number(baseline.resource_counts.audit_log)}::int)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  logRing.clear();
  await registerExecutionRunHandler({ db, boss });
  await registerConversationRunTurnHandler({ db, boss });
  try {
    await waitFor(
      async () => {
        const [executed] = await db
          .select()
          .from(executions)
          .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, execution.id)));
        const [chatted] = await db
          .select()
          .from(mcpTasks)
          .where(and(eq(mcpTasks.tenant_id, tenantId), eq(mcpTasks.id, task.id)));
        return executed?.status === "failed" && Boolean(chatted?.failure_reason);
      },
      {
        tries: 200,
        sleepMs: 50,
        label: "full content quota produces durable terminal task outcomes",
      },
    ).catch(async (error: unknown) => {
      const [executed] = await db
        .select({ status: executions.status, failure: executions.failure })
        .from(executions)
        .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, execution.id)));
      const [chatted] = await db
        .select({
          failure_reason: mcpTasks.failure_reason,
          result: mcpTasks.result,
          job_id: mcpTasks.job_id,
        })
        .from(mcpTasks)
        .where(and(eq(mcpTasks.tenant_id, tenantId), eq(mcpTasks.id, task.id)));
      const chatJobs = await boss.findJobs(CONVERSATION_RUN_TURN_QUEUE, { id: jobId });
      throw new Error(
        JSON.stringify({
          executed,
          chatted,
          chat_jobs: chatJobs.map((job) => ({
            state: job.state,
            output: safeWorkerError(Reflect.get(job, "output")),
          })),
          chat_phases: safeWorkerPhases(tenantId),
        }),
        { cause: error },
      );
    });
    await waitFor(
      async () => {
        const jobs = [
          ...(await boss.findJobs(EXECUTION_RUN_QUEUE, { id: execution.id })),
          ...(await boss.findJobs(CONVERSATION_RUN_TURN_QUEUE, { id: jobId })),
        ];
        const admissions = await db
          .select()
          .from(hostedWorkAdmissions)
          .where(eq(hostedWorkAdmissions.tenant_id, tenantId));
        return (
          jobs.length === 2 &&
          jobs.every((job) => job.state === "completed") &&
          admissions.every((row) => row.state === "released")
        );
      },
      {
        tries: 200,
        sleepMs: 50,
        label: "actual workers acknowledge terminal jobs and release admissions",
      },
    );
    const [executed] = await db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, execution.id)));
    const [chatted] = await db
      .select()
      .from(mcpTasks)
      .where(and(eq(mcpTasks.tenant_id, tenantId), eq(mcpTasks.id, task.id)));
    expect(executed?.failure?.error_code).toBe("hosted_storage_quota_exhausted");
    expect(chatted?.failure_reason).toBe("hosted_storage_quota_exhausted");
    const failureData = JSON.stringify({
      failure: executed?.failure,
      chat: chatted?.failure_reason,
      logs: logRing.tail({ limit: 1000 }),
    });
    expect(failureData).not.toContain(canary);
    expect(failureData).not.toContain("Failed query:");
    expect(
      await db.select().from(executionSteps).where(eq(executionSteps.tenant_id, tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.tenant_id, tenantId)),
    ).toHaveLength(1);
    const [after] = await db
      .select()
      .from(hostedTenantUsage)
      .where(eq(hostedTenantUsage.tenant_id, tenantId));
    expect(after?.logical_bytes).toBe(baseline.logical_bytes);
    expect(after?.resource_counts).toEqual(baseline.resource_counts);
    expect(await db.select().from(events).where(eq(events.tenant_id, tenantId))).toHaveLength(0);
    const receipts = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.reason, "hosted_storage_quota_exhausted"),
        ),
      );
    expect(receipts).toHaveLength(2);
    expect(JSON.stringify(receipts)).not.toContain(canary);
    const executionReceipt = receipts.find((row) => row.resource_id === execution.id);
    const conversationReceipt = receipts.find((row) => row.resource_id === task.id);
    expect(executionReceipt?.metadata).toMatchObject({
      origin_source: "ui",
      execution_source: "queue",
      audit_trace_id: executionCorrelation,
    });
    expect(conversationReceipt?.metadata).toMatchObject({
      origin_source: "mcp",
      execution_source: "queue",
      audit_trace_id: conversationCorrelation,
    });
  } finally {
    await boss.offWork(EXECUTION_RUN_QUEUE);
    await boss.offWork(CONVERSATION_RUN_TURN_QUEUE);
  }
}, 30_000);

test("self-hosted typed quota errors use ordinary worker failure settlement", async () => {
  const db = connection.db;
  const tenant = await seedTenant(db, {
    slug: "quota-selfhost-control",
    display_name: "Self hosted",
  });
  const role = { id: await builtinRoleId(db, "admin") };
  const [user] = await db
    .insert(users)
    .values({ tenant_id: tenant.id, role_id: role.id, email: "selfhost@example.test" })
    .returning();
  if (!user) throw new Error("user missing");
  const [session] = await db
    .insert(sessions)
    .values({
      tenant_id: tenant.id,
      user_id: user.id,
      expires_at: new Date(now() + 3600000),
      absolute_expires_at: new Date(now() + 3600000),
    })
    .returning();
  if (!session) throw new Error("session missing");
  const principal: ResolvedPrincipal = {
    kind: "user",
    id: user.id,
    tenant_id: tenant.id,
    provider: "browser_session",
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  const [workflow] = await db
    .insert(workflows)
    .values({
      tenant_id: tenant.id,
      slug: "selfhost-control",
      name: "Self hosted control",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow missing");
  const [execution] = await db
    .insert(executions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      status: "queued",
      hold_writes: true,
      request_source: "api",
      execution_mode: "dev",
      caller_context: callerFromPrincipal(principal, tenant.id),
      authorization_context: authorizationContextFromPrincipal(principal),
    })
    .returning();
  if (!execution) throw new Error("execution missing");
  await db.execute(
    sql`CREATE FUNCTION subkit.test_selfhost_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.authorization_context IS DISTINCT FROM OLD.authorization_context THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_storage_quota_exhausted'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER test_selfhost_quota BEFORE UPDATE ON subkit.executions FOR EACH ROW WHEN (OLD.tenant_id=${sql.raw(`'${tenant.id}'::uuid`)}) EXECUTE FUNCTION subkit.test_selfhost_quota()`,
  );
  await boss.send(
    EXECUTION_RUN_QUEUE,
    { tenant_id: tenant.id, execution_id: execution.id, workflow_id: workflow.id },
    { id: execution.id },
  );
  await registerExecutionRunHandler({ db, boss });
  try {
    await waitFor(
      async () =>
        (await boss.findJobs(EXECUTION_RUN_QUEUE, { id: execution.id }))[0]?.state === "completed",
      {
        tries: 200,
        sleepMs: 50,
        label: "self-hosted typed quota failure acknowledged after settlement",
      },
    );
    const [saved] = await db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, tenant.id), eq(executions.id, execution.id)));
    expect(saved?.status).toBe("failed");
    expect(saved?.finished_at).not.toBeNull();
    expect(saved?.failure?.error_code).toBe("hosted_storage_quota_exhausted");
    expect(
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, tenant.id), eq(auditLog.action, "execution.failed"))),
    ).toHaveLength(0);
  } finally {
    await boss.offWork(EXECUTION_RUN_QUEUE);
    await db.execute(sql`DROP TRIGGER test_selfhost_quota ON subkit.executions`);
    await db.execute(sql`DROP FUNCTION subkit.test_selfhost_quota()`);
  }
});
