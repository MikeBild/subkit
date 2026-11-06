import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/self-healing.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let readerKey: string;
let scanId: string;

function uuidName(uuid: string): string {
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(ctx.userId, "<admin>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"duration_ms":\d+/g, '"duration_ms":"<ms>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(
      /(?<![0-9a-f-])(?!0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g,
      (m) => uuidName(m),
    );
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  init: { body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${init.key ?? ctx.apiKey}`,
      "content-type": "application/json",
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { text } };
  }
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

async function auditTrail(where: ReturnType<typeof eq>): Promise<string[]> {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), where));
  return rows.map((row) => normalize(row).replace(/<uuid:\d+>/g, "<id>")).sort();
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_self_healing_golden");
  deniedKey = await seedKey(
    "denied-self-healing@test.local",
    await emptyRoleId(ctx.db, ctx.tenantId),
    0x5e_1f,
  );
  const reader = await createRole(ctx.db, ctx.tenantId, "self-healing-reader");
  await grantPermissionToRole(ctx.db, ctx.tenantId, reader.id, "self_healing:read");
  readerKey = await seedKey("reader-self-healing@test.local", reader.id, 0x5e_20);
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

describe("self-healing scan routes keep their HTTP responses byte for byte", () => {
  test("scan", async () => {
    const first = await http("POST", "/v1/self-healing/scans", { body: {} });
    scanId = (first.body as { scan_id: string }).scan_id;
    record("http.scan", first);
    record("http.scan.no-body", await http("POST", "/v1/self-healing/scans"));
    const keyed = { headers: { "idempotency-key": "golden-scan-0001" }, body: {} };
    record("http.scan.keyed", await http("POST", "/v1/self-healing/scans", keyed));
    record("http.scan.replay", await http("POST", "/v1/self-healing/scans", keyed));
    record(
      "http.scan.short-key",
      await http("POST", "/v1/self-healing/scans", { headers: { "idempotency-key": "abc" } }),
    );
    record(
      "http.scan.invalid",
      await http("POST", "/v1/self-healing/scans", { body: { workflow_id: "nope" } }),
    );
    record(
      "http.scan.workflow",
      await http("POST", "/v1/self-healing/scans", { body: { workflow_id: MISSING } }),
    );
  });

  test("list and get", async () => {
    record("http.list", await http("GET", "/v1/self-healing/scans"));
    record("http.list.limited", await http("GET", "/v1/self-healing/scans?limit=1"));
    record("http.list.filtered", await http("GET", "/v1/self-healing/scans?source=mcp"));
    record("http.list.invalid", await http("GET", "/v1/self-healing/scans?limit=0"));
    record("http.get", await http("GET", `/v1/self-healing/scans/${scanId}`));
    record("http.get.missing", await http("GET", `/v1/self-healing/scans/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/self-healing/scans/nope"));
  });

  test("permission is checked before the input is validated", async () => {
    const calls: [string, string, string][] = [
      ["scan", "POST", "/v1/self-healing/scans"],
      ["list", "GET", "/v1/self-healing/scans?limit=0"],
      ["get", "GET", "/v1/self-healing/scans/nope"],
      ["head.list", "HEAD", "/v1/self-healing/scans"],
      ["head.get", "HEAD", `/v1/self-healing/scans/${MISSING}`],
      ["other-method.list", "DELETE", "/v1/self-healing/scans"],
      ["other-method.get", "POST", `/v1/self-healing/scans/${MISSING}`],
    ];
    for (const [name, method, path] of calls) {
      record(`http.denied.${name}`, await http(method, path, { key: deniedKey }));
    }
    record("http.reader.scan", await http("POST", "/v1/self-healing/scans", { key: readerKey }));
    record(
      "http.reader.other-method.list",
      await http("PUT", "/v1/self-healing/scans", { key: readerKey }),
    );
    record("http.denied.audit", await auditTrail(eq(auditLog.result, "denied")));
  });

  test("every scan wrote its audit rows", async () => {
    record("http.audit", await auditTrail(like(auditLog.action, "self_healing%")));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
