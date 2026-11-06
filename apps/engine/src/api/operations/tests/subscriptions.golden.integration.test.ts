import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/subscriptions.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let subscriptionId: string;

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

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_subscriptions_golden");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-subscriptions-operations@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0x5b_5c)(16)}`;
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
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("subscription operations keep their HTTP responses byte for byte", () => {
  test("create and list", async () => {
    record("http.list.empty", await http("GET", "/v1/subscriptions"));
    const created = await http("POST", "/v1/subscriptions", {
      event_pattern: "execution.*",
      target_url: "https://hooks.example.test/subkit",
      secret: "golden-secret",
    });
    subscriptionId = (created.body as { id: string }).id;
    record("http.create", created);
    record(
      "http.create.inactive",
      await http("POST", "/v1/subscriptions", {
        event_pattern: "workflow.*",
        target_url: "https://hooks.example.test/paused",
        secret: "golden-secret-two",
        active: false,
      }),
    );
    record(
      "http.create.invalid",
      await http("POST", "/v1/subscriptions", { event_pattern: "", target_url: "nope" }),
    );
    record("http.list", await http("GET", "/v1/subscriptions"));
  });

  test("get", async () => {
    record("http.get", await http("GET", `/v1/subscriptions/${subscriptionId}`));
    record("http.get.missing", await http("GET", `/v1/subscriptions/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/subscriptions/not-a-uuid"));
  });

  test("update", async () => {
    record(
      "http.update",
      await http("PATCH", `/v1/subscriptions/${subscriptionId}`, {
        event_pattern: "execution.failed",
        rotating_secret: "golden-rotating",
        active: false,
      }),
    );
    record(
      "http.update.secret",
      await http("PATCH", `/v1/subscriptions/${subscriptionId}`, {
        secret: "golden-secret-rotated",
        target_url: "https://hooks.example.test/rotated",
        rotating_secret: null,
      }),
    );
    record("http.update.empty", await http("PATCH", `/v1/subscriptions/${subscriptionId}`, {}));
    record(
      "http.update.missing",
      await http("PATCH", `/v1/subscriptions/${MISSING}`, { active: true }),
    );
    record(
      "http.update.invalid",
      await http("PATCH", `/v1/subscriptions/${subscriptionId}`, { target_url: "nope" }),
    );
  });

  test("replay", async () => {
    record(
      "http.replay.missing",
      await http("POST", `/v1/subscriptions/${subscriptionId}/deliveries/${MISSING}/replay`),
    );
    record(
      "http.replay.invalid",
      await http("POST", `/v1/subscriptions/${subscriptionId}/deliveries/nope/replay`),
    );
  });

  test("permission is checked before the body is validated", async () => {
    const id = subscriptionId;
    record("http.denied.list", await http("GET", "/v1/subscriptions", undefined, deniedKey));
    record("http.denied.create", await http("POST", "/v1/subscriptions", {}, deniedKey));
    record("http.denied.get", await http("GET", `/v1/subscriptions/${id}`, undefined, deniedKey));
    record("http.denied.update", await http("PATCH", `/v1/subscriptions/${id}`, {}, deniedKey));
    record(
      "http.denied.delete",
      await http("DELETE", `/v1/subscriptions/${id}`, undefined, deniedKey),
    );
    record(
      "http.denied.replay",
      await http("POST", `/v1/subscriptions/${id}/deliveries/${MISSING}/replay`, {}, deniedKey),
    );
    record("http.denied.head.list", await http("HEAD", "/v1/subscriptions", undefined, deniedKey));
    record(
      "http.denied.head.get",
      await http("HEAD", `/v1/subscriptions/${id}`, undefined, deniedKey),
    );
    record("http.denied.other-method.list", await http("PUT", "/v1/subscriptions", {}, deniedKey));
    record(
      "http.denied.other-method.get",
      await http("PUT", `/v1/subscriptions/${id}`, {}, deniedKey),
    );
    record(
      "http.denied.other-method.replay",
      await http(
        "GET",
        `/v1/subscriptions/${id}/deliveries/${MISSING}/replay`,
        undefined,
        deniedKey,
      ),
    );
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("delete", async () => {
    record("http.delete", await http("DELETE", `/v1/subscriptions/${subscriptionId}`));
    record("http.delete.again", await http("DELETE", `/v1/subscriptions/${subscriptionId}`));
    record("http.delete.get", await http("GET", `/v1/subscriptions/${subscriptionId}`));
  });

  test("audit trail of the written subscription", async () => {
    recordRows("http.audit", await auditRows(eq(auditLog.resource_id, subscriptionId)));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
