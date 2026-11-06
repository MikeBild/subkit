import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { auditLog, executions, users } from "../../../db/schema/index.ts";
import { protectExecutionPayload } from "../../../execution/sensitive-payload.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { seedTimestamp, seedUuid, seedWorkflow } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/executions-result.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let deniedKey: string;
let deniedUserId: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const FOREIGN_CALLER = "5eed00e2-0000-4000-8000-000000000002";

function executionId(n: number): string {
  return `5eed00e0-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const OWNED = executionId(1);
const PLAIN = executionId(2);
const RUNNING = executionId(3);
const FOREIGN = executionId(4);
const ANONYMOUS = executionId(5);
const PLAIN_RESULT = executionId(6);

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(ctx.userId, "<owner>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    );
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(path: string, key = ctx.apiKey): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function caller(principalId: string) {
  return {
    tenantId: ctx.tenantId,
    principalId,
    principalKind: "user" as const,
    provider: "api_key",
    productId: null,
  };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_executions_result_golden");
  const { workflow, version } = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 1),
    created_at: seedTimestamp(1),
    updated_at: seedTimestamp(1),
    version: { id: seedUuid("workflow_version", 1), created_at: seedTimestamp(1) },
    slug: "sensitive-report",
    name: "Sensitive report",
  });
  const base = {
    tenant_id: ctx.tenantId,
    request_source: "api",
    execution_mode: "prod" as const,
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    started_at: seedTimestamp(10),
    finished_at: seedTimestamp(11),
    created_at: seedTimestamp(10),
  };
  const sealed = (id: string) => ({
    input: protectExecutionPayload({ order: 1 }, ctx.tenantId, id, "input"),
    sensitive_result: protectExecutionPayload({ text: "secret" }, ctx.tenantId, id, "result"),
  });
  const rows: (typeof executions.$inferInsert)[] = [
    {
      ...base,
      ...sealed(OWNED),
      id: OWNED,
      status: "succeeded",
      caller_context: caller(ctx.userId),
    },
    {
      ...base,
      id: PLAIN,
      status: "succeeded",
      input: { order: 2 },
      caller_context: caller(ctx.userId),
    },
    {
      ...base,
      ...sealed(RUNNING),
      id: RUNNING,
      status: "running",
      caller_context: caller(ctx.userId),
    },
    {
      ...base,
      ...sealed(FOREIGN),
      id: FOREIGN,
      status: "succeeded",
      caller_context: caller(FOREIGN_CALLER),
    },
    { ...base, ...sealed(ANONYMOUS), id: ANONYMOUS, status: "succeeded" },
    {
      ...base,
      id: PLAIN_RESULT,
      status: "succeeded",
      input: protectExecutionPayload({ order: 3 }, ctx.tenantId, PLAIN_RESULT, "input"),
      sensitive_result: { text: "plain" },
      caller_context: caller(ctx.userId),
    },
  ];
  await ctx.db.insert(executions).values(rows);
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-execution-result@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedUserId = denied.id;
  const rand = createDeterministicHexFactory(0x60_1f)(16);
  deniedKey = `wf_live_${rand}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      denied.id,
      deniedKey.slice(0, 12),
      createHash("sha256").update(deniedKey).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the sensitive result route keeps its HTTP responses and audit trail", () => {
  test("result", async () => {
    record("http.result", await http(`/v1/executions/${OWNED}/result`));
    record("http.result.plain", await http(`/v1/executions/${PLAIN}/result`));
    record("http.result.running", await http(`/v1/executions/${RUNNING}/result`));
    record("http.result.plain-result", await http(`/v1/executions/${PLAIN_RESULT}/result`));
    record("http.result.missing", await http(`/v1/executions/${MISSING}/result`));
    record("http.result.invalid", await http("/v1/executions/not-a-uuid/result"));
    record("http.result.foreign", await http(`/v1/executions/${FOREIGN}/result`));
    record("http.result.anonymous", await http(`/v1/executions/${ANONYMOUS}/result`));
    const trail = await ctx.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          inArray(auditLog.resource_id, [OWNED, PLAIN, RUNNING, FOREIGN, ANONYMOUS, PLAIN_RESULT]),
        ),
      )
      .orderBy(asc(auditLog.resource_id), asc(auditLog.ts), asc(auditLog.action));
    record("http.result.audit", trail);
  });

  test("permission is checked before the input is validated", async () => {
    record("http.denied.result", await http(`/v1/executions/${OWNED}/result`, deniedKey));
    record("http.denied.result.invalid", await http("/v1/executions/not-a-uuid/result", deniedKey));
    const trail = await ctx.db
      .select({
        action: auditLog.action,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.actor_id, deniedUserId)))
      .orderBy(asc(auditLog.ts), asc(auditLog.action));
    record("http.denied.audit", trail);
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
