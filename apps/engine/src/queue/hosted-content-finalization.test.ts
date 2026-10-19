import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createDbFromUrl } from "../db/client.ts";
import {
  HOSTED_CONTENT_QUOTA_MESSAGE,
  hostedControlReceiptId,
} from "../db/hosted-control-receipt.ts";
import { hostedQuotaError } from "../db/hosted-quota-errors.ts";
import {
  auditLog,
  conversations,
  events,
  executions,
  hostedTenantUsage,
  mcpTasks,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { now } from "../utils/clock.ts";
import { finalizeHostedContentQuota } from "./hosted-content-finalization.ts";

let fixture: TestDb;
let connection: ReturnType<typeof createDbFromUrl>;
let tenantId: string;
let userId: string;
const nextId = createDeterministicUuidFactory(9187);
const code = "hosted_storage_quota_exhausted" as const;
const failure = { step_id: null, error_code: code, error_message: HOSTED_CONTENT_QUOTA_MESSAGE };
beforeAll(async () => {
  fixture = await createTestDb("hosted-quota-control");
  await configureHostedPolicyForTests(fixture.db, fixture.url);
  connection = createDbFromUrl(fixture.url);
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "quota-control",
      email: "quota-control@example.test",
      email_verified: true,
    },
    connection.db,
  );
  tenantId = owned.tenant.id;
  userId = owned.membership.user_id;
});
afterAll(async () => {
  await connection?.pool.end();
  await fixture?.cleanup();
});
beforeEach(async () => {
  await policy("50000000", 1000);
});
async function policy(bytes: string, rows: number) {
  await connection.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${bytes}::text)),'{storage,hosted,retained_rows_per_resource}',to_jsonb(${rows}::int)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
}
async function queued() {
  const [row] = await connection.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      status: "queued",
      execution_mode: "dev",
      request_source: "api",
      input: { private: "private-terminal-fixture-canary" },
    })
    .returning();
  if (!row) throw new Error("accepted execution missing");
  return row;
}
async function usage() {
  const [row] = await connection.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!row) throw new Error("usage missing");
  return row;
}
function receipt(resourceId: string) {
  return {
    id: hostedControlReceiptId(tenantId, "execution", resourceId),
    tenant_id: tenantId,
    actor_type: "system",
    actor_id: null,
    action: "execution.failed",
    resource_type: "execution",
    resource_id: resourceId,
    result: "denied",
    reason: code,
    metadata: { code },
    before: null,
    after: null,
    ip: null,
    user_agent: null,
    trace_id: "",
  };
}

test("exactly full byte and audit row caps permit one atomic terminal receipt and replay creates none", async () => {
  const row = await queued();
  const before = await usage();
  await policy(before.logical_bytes.toString(), Number(before.resource_counts.audit_log));
  expect(
    await finalizeHostedContentQuota(connection.db, {
      tenantId,
      resourceType: "execution",
      resourceId: row.id,
      code,
    }),
  ).toBe("finalized");
  expect(
    await finalizeHostedContentQuota(connection.db, {
      tenantId,
      resourceType: "execution",
      resourceId: row.id,
      code,
    }),
  ).toBe("stale");
  await connection.db.insert(auditLog).values(receipt(row.id)).onConflictDoNothing();
  const stored = await connection.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.id, hostedControlReceiptId(tenantId, "execution", row.id)),
      ),
    );
  expect(stored).toHaveLength(1);
  expect(stored[0]?.metadata).toEqual({ code });
  const [terminal] = await connection.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, row.id)));
  expect(terminal?.failure).toEqual(failure);
  expect(terminal?.finished_at).not.toBeNull();
  const after = await usage();
  expect(after.logical_bytes).toBe(before.logical_bytes);
  expect(after.resource_counts.audit_log).toBe(before.resource_counts.audit_log);
});

for (const variant of [
  "counterfeit_id",
  "unbound_resource",
  "extra_json",
  "wrong_actor",
  "private_failure",
  "missing_finished_at",
  "missing_receipt",
] as const) {
  test(`terminal quota control rejects ${variant}`, async () => {
    const row = await queued();
    const before = await usage();
    await policy(before.logical_bytes.toString(), Number(before.resource_counts.audit_log));
    let denied: unknown;
    try {
      await connection.db.transaction(async (tx) => {
        await tx
          .update(executions)
          .set({
            status: "failed",
            finished_at: variant === "missing_finished_at" ? null : new Date(now()),
            failure:
              variant === "private_failure"
                ? { ...failure, error_message: "private-terminal-canary" }
                : failure,
          })
          .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, row.id)));
        if (variant === "missing_receipt") return;
        const value = receipt(variant === "unbound_resource" ? nextId() : row.id);
        if (variant === "counterfeit_id") value.id = nextId();
        if (variant === "extra_json")
          Object.assign(value.metadata, { private: "private-terminal-canary" });
        if (variant === "wrong_actor")
          Object.assign(value, { actor_type: "user", actor_id: userId });
        await tx.insert(auditLog).values(value);
      });
    } catch (error) {
      denied = error;
    }
    expect(hostedQuotaError(denied)).not.toBeNull();
    expect(String(denied)).not.toContain("private-terminal-canary");
    const [after] = await connection.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, row.id)));
    expect(after?.status).toBe("queued");
    expect((await usage()).logical_bytes).toBe(before.logical_bytes);
  });
}

test("a stale conversation attempt cannot settle the current job or create a receipt", async () => {
  const [conversation] = await connection.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!conversation) throw new Error("conversation missing");
  const jobId = nextId();
  const [task] = await connection.db
    .insert(mcpTasks)
    .values({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      kind: "start",
      turn_seq: 1,
      job_id: jobId,
    })
    .returning();
  if (!task) throw new Error("task missing");
  const before = await usage();
  await policy(before.logical_bytes.toString(), Number(before.resource_counts.audit_log));
  expect(
    await finalizeHostedContentQuota(connection.db, {
      tenantId,
      resourceType: "mcp_task",
      resourceId: task.id,
      expectedJobId: nextId(),
      code,
    }),
  ).toBe("stale");
  const [unchanged] = await connection.db
    .select()
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, tenantId), eq(mcpTasks.id, task.id)));
  expect(unchanged?.failure_reason).toBeNull();
  expect(
    await finalizeHostedContentQuota(connection.db, {
      tenantId,
      resourceType: "mcp_task",
      resourceId: task.id,
      expectedJobId: jobId,
      code,
    }),
  ).toBe("finalized");
});

test("fixed terminal receipts never grant a free outbox event slot", async () => {
  const row = await queued();
  const before = await usage();
  await policy(before.logical_bytes.toString(), Number(before.resource_counts.audit_log));
  await finalizeHostedContentQuota(connection.db, {
    tenantId,
    resourceType: "execution",
    resourceId: row.id,
    code,
  });
  let denied: unknown;
  try {
    await connection.db.insert(events).values({
      tenant_id: tenantId,
      channel: "execution.status",
      type: "execution.failed",
      payload: { execution_id: row.id, status: "failed", failure },
    });
  } catch (error) {
    denied = error;
  }
  expect(hostedQuotaError(denied)?.code).toBe("hosted_storage_quota_exhausted");
  const [terminal] = await connection.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, row.id)));
  expect(terminal?.status).toBe("failed");
  expect(
    await connection.db.select().from(events).where(eq(events.tenant_id, tenantId)),
  ).toHaveLength(0);
});
