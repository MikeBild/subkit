import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, permissions, rolePermissions, roles, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/request-hooks.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let editorKey: string;
let systemKey: string;
let hookId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"');
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value).replace(UUID, uuidName);
  expect(actual[name]).toBe(golden[name] as string);
}

function recordRows(name: string, rows: readonly unknown[]): void {
  actual[name] = JSON.stringify(rows.map((row) => scrub(row).replace(UUID, "<id>")).sort());
  expect(actual[name]).toBe(golden[name] as string);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text) };
}

function auditRows(where: ReturnType<typeof eq>) {
  return ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), where));
}

async function mintKey(owner: { user_id?: string; system_account_id?: string }, seed: number) {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, system_account_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [
      ctx.tenantId,
      owner.user_id ?? null,
      owner.system_account_id ?? null,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return key;
}

async function seedUser(email: string, role_id: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id })
    .returning();
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_request_hooks_golden");
  const deniedUser = await seedUser(
    "denied-request-hooks-operations@test.local",
    await emptyRoleId(ctx.db, ctx.tenantId),
  );
  deniedKey = await mintKey({ user_id: deniedUser }, 0x4e_01);
  const [editorRole] = await ctx.db
    .insert(roles)
    .values({ tenant_id: ctx.tenantId, name: "hook-editor", description: "rbac without admin" })
    .returning({ id: roles.id });
  if (!editorRole) throw new Error("role insert returned no row");
  const granted = await ctx.db
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.name, ["rbac:read", "rbac:write"]));
  await ctx.db
    .insert(rolePermissions)
    .values(granted.map((p) => ({ role_id: editorRole.id, permission_id: p.id })));
  const editorUser = await seedUser("hook-editor-operations@test.local", editorRole.id);
  editorKey = await mintKey({ user_id: editorUser }, 0x4e_02);
  systemKey = await mintKey({ system_account_id: ctx.systemAccountId }, 0x4e_03);
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

const VALID = "return { allow: true };";
const BROKEN = "return { allow: ";

describe("request hook operations keep their HTTP responses byte for byte", () => {
  test("create and list", async () => {
    record("http.list.empty", await http("GET", "/v1/auth/request-hooks"));
    const created = await http("POST", "/v1/auth/request-hooks", {
      role: "member",
      code: VALID,
      description: "Golden hook",
    });
    hookId = (created.body as { id: string }).id;
    record("http.create", created);
    record(
      "http.create.disabled",
      await http("POST", "/v1/auth/request-hooks", { role: "viewer", code: VALID, enabled: false }),
    );
    record(
      "http.create.broken",
      await http("POST", "/v1/auth/request-hooks", { role: "member", code: BROKEN }),
    );
    record("http.create.invalid", await http("POST", "/v1/auth/request-hooks", { role: "" }));
    record("http.list", await http("GET", "/v1/auth/request-hooks"));
  });

  test("update", async () => {
    record(
      "http.update",
      await http("PATCH", `/v1/auth/request-hooks/${hookId}`, {
        code: 'return { allow: false, reason: "golden" };',
        description: "Changed",
      }),
    );
    record(
      "http.update.enabled",
      await http("PATCH", `/v1/auth/request-hooks/${hookId}`, { enabled: false }),
    );
    record(
      "http.update.broken",
      await http("PATCH", `/v1/auth/request-hooks/${hookId}`, { code: BROKEN }),
    );
    record(
      "http.update.missing",
      await http("PATCH", `/v1/auth/request-hooks/${MISSING}`, { enabled: true }),
    );
    record(
      "http.update.missing-broken",
      await http("PATCH", `/v1/auth/request-hooks/${MISSING}`, { code: BROKEN }),
    );
    record("http.update.invalid", await http("PATCH", "/v1/auth/request-hooks/nope", {}));
  });

  test("permission and admin policy are checked", async () => {
    const id = hookId;
    for (const [who, key] of [
      ["denied", deniedKey],
      ["editor", editorKey],
      ["system", systemKey],
    ] as const) {
      record(`http.${who}.list`, await http("GET", "/v1/auth/request-hooks", undefined, key));
      record(`http.${who}.create`, await http("POST", "/v1/auth/request-hooks", {}, key));
      record(
        `http.${who}.create.valid`,
        await http("POST", "/v1/auth/request-hooks", { role: "member", code: VALID }, key),
      );
      record(`http.${who}.update`, await http("PATCH", `/v1/auth/request-hooks/${id}`, {}, key));
      record(
        `http.${who}.delete`,
        await http("DELETE", `/v1/auth/request-hooks/${id}`, undefined, key),
      );
      record(`http.${who}.head`, await http("HEAD", "/v1/auth/request-hooks", undefined, key));
      record(`http.${who}.other-method.list`, await http("PUT", "/v1/auth/request-hooks", {}, key));
      record(
        `http.${who}.other-method.item`,
        await http("GET", `/v1/auth/request-hooks/${id}`, undefined, key),
      );
    }
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("audit rows carry the request trace id", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/auth/request-hooks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
        "x-sk-trace-id": "golden-request-hook-trace",
      },
      body: JSON.stringify({ role: "auditor", code: VALID }),
    });
    const created = (await res.json()) as { id: string };
    const rows = await ctx.db
      .select({ recorded_trace: auditLog.trace_id, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, created.id)));
    record("http.audit.trace", rows);
  });

  test("delete", async () => {
    record("http.delete", await http("DELETE", `/v1/auth/request-hooks/${hookId}`));
    record("http.delete.again", await http("DELETE", `/v1/auth/request-hooks/${hookId}`));
    record("http.delete.invalid", await http("DELETE", "/v1/auth/request-hooks/nope"));
    record("http.delete.list", await http("GET", "/v1/auth/request-hooks"));
  });

  test("audit trail of the written hook", async () => {
    recordRows("http.audit", await auditRows(eq(auditLog.resource_id, hookId)));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
