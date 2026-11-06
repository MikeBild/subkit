import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { getConfig } from "../../../config/loader.ts";
import { listConfigLeaves } from "../../../config/walk.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { RuntimeConfigCoordinator } from "../../../runtime-config/coordinator.ts";
import { createSecretVersion, initializeRuntimeConfig } from "../../../runtime-config/service.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/secret-approvals.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let deniedKey: string;
let readerKey: string;
let bindingPath = "";
let secretName = "";

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(ctx.userId, "<admin>")
    .replaceAll(secretName, "<secret>")
    .replaceAll(bindingPath, "<binding>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedKey(email: string, roleId: string, seed: number): Promise<string> {
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id: roleId })
    .returning();
  if (!user) throw new Error("user insert returned no row");
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      user.id,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return key;
}

async function auditTrail(result: "denied" | "settled"): Promise<string[]> {
  const rows = await ctx.db
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
      result === "denied"
        ? and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied"))
        : and(eq(auditLog.tenant_id, ctx.tenantId), like(auditLog.action, "secret.version_%")),
    );
  return rows.map((row) => normalize(row)).sort();
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_secret_approvals_golden");
  await initializeRuntimeConfig(ctx.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(ctx.db, "test", "replica-secret-golden");
  await coordinator.start();
  const leaf = listConfigLeaves().find(
    (l) => l.meta.secret && (l.meta.scope ?? "global") === "global" && !l.meta.requiresRestart,
  );
  if (!leaf) throw new Error("no global secret leaf to bind in this schema");
  bindingPath = leaf.path.join(".");
  secretName = `settings.${bindingPath}`;
  for (const [value, bindings] of [
    ["first-key", [bindingPath]],
    ["second-key", []],
  ] as const) {
    await createSecretVersion(ctx.db, {
      name: secretName,
      value,
      created_by: null,
      pending: {
        prepared_by: "Host-Kommando (engine --vault-set --pending)",
        bindings: [...bindings],
      },
    });
  }
  deniedKey = await seedKey(
    "denied-secret-approvals@test.local",
    await emptyRoleId(ctx.db, ctx.tenantId),
    0x5e_c1,
  );
  const reader = await createRole(ctx.db, ctx.tenantId, "secret-reader");
  await grantPermissionToRole(ctx.db, ctx.tenantId, reader.id, "settings:read:global");
  readerKey = await seedKey("reader-secret-approvals@test.local", reader.id, 0x5e_c2);
}, 60_000);

afterAll(async () => {
  await coordinator?.stop();
  await ctx?.cleanup();
});

describe("secret approvals keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/secret-approvals"));
  });

  test("a settings:read:global reader lists the queue without settings:write:global", async () => {
    const list = await http("GET", "/v1/secret-approvals", readerKey);
    expect(list.status).toBe(200);
    expect((list.body as { items: { name: string; version: number }[] }).items).toEqual([
      expect.objectContaining({ name: secretName, version: 1 }),
      expect.objectContaining({ name: secretName, version: 2 }),
    ]);
    const decide = await http("POST", `/v1/secret-approvals/${secretName}/1/approve`, readerKey);
    expect(decide.status).toBe(403);
    expect((decide.body as { message: string }).message).toBe(
      "permission_denied:settings:write:global",
    );
  });

  test("reject and approve", async () => {
    const base = `/v1/secret-approvals/${secretName}`;
    record("http.reject", await http("POST", `${base}/2/reject`));
    record("http.reject.again", await http("POST", `${base}/2/reject`));
    record("http.reject.invalid", await http("POST", `${base}/0/reject`));
    record("http.approve.unknown", await http("POST", `${base}/9/approve`));
    record("http.approve.invalid-name", await http("POST", "/v1/secret-approvals/-bad/1/approve"));
    record("http.approve", await http("POST", `${base}/1/approve`));
    record("http.approve.again", await http("POST", `${base}/1/approve`));
    record("http.list.empty", await http("GET", "/v1/secret-approvals"));
  });

  test("permission is checked before the input is validated", async () => {
    const base = `/v1/secret-approvals/${secretName}`;
    const calls: [string, string, string][] = [
      ["list", "GET", "/v1/secret-approvals"],
      ["head.list", "HEAD", "/v1/secret-approvals"],
      ["other-method.list", "POST", "/v1/secret-approvals"],
      ["approve", "POST", `${base}/0/approve`],
      ["reject", "POST", `${base}/0/reject`],
      ["other-method.approve", "GET", `${base}/1/approve`],
    ];
    for (const [name, method, path] of calls) {
      record(`http.denied.${name}`, await http(method, path, deniedKey));
      record(`http.reader.${name}`, await http(method, path, readerKey));
    }
    record("http.denied.audit", await auditTrail("denied"));
  });

  test("every decision wrote its audit row", async () => {
    record("http.audit", await auditTrail("settled"));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
