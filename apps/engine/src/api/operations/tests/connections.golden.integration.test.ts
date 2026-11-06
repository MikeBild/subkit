import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import {
  type FakeOAuthServer,
  startFakeOAuthServer,
} from "../../../credentials/connections/tests/fake-oauth-server.ts";
import { apiKeys, auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/connections.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let fake: FakeOAuthServer;
let deniedKey: string;
let connectionId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function authorizationShape(value: string): string {
  const url = new URL(value);
  const stable = ["scope", "redirect_uri", "code_challenge_method", "response_type"];
  const params = [...url.searchParams.keys()]
    .sort()
    .map((key) =>
      stable.includes(key) ? `${key}=${url.searchParams.get(key)}` : `${key}=<volatile>`,
    );
  return `${url.origin}${url.pathname}?${params.join("&")}`;
}

function scrub(value: unknown): string {
  return JSON.stringify(value, (key, field) =>
    key === "authorization_url" && typeof field === "string" ? authorizationShape(field) : field,
  )
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(fake.baseUrl, "<fake>")
    .replaceAll(new URL(fake.baseUrl).host, "<fake-host>")
    .replaceAll(ctx.baseUrl, "<engine>")
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
  key: string | null = ctx.apiKey,
): Promise<{ status: number; body: unknown; location?: string }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const location = res.headers.get("location");
  return { status: res.status, body: parseBody(text), ...(location ? { location } : {}) };
}

function auditRows(where: ReturnType<typeof eq | typeof like>) {
  return ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), where));
}

async function approve(authorizationUrl: string): Promise<{ status: number; body: unknown }> {
  const consent = await fetch(authorizationUrl, { redirect: "manual" });
  const callback = consent.headers.get("location") ?? "";
  const landed = await fetch(callback, { redirect: "manual" });
  return { status: landed.status, body: parseBody(await landed.text()) };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_connections_golden");
  fake = await startFakeOAuthServer({ name: "Golden Service" });
  await setConfigKey("server.public_base_url", ctx.baseUrl, { force: true });
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-connections-operations@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0x6c_11)(16)}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: denied.id,
    prefix: deniedKey.slice(0, 12),
    token_sha256: createHash("sha256").update(deniedKey).digest("hex"),
    scopes: ["*"],
  });
}, 60_000);

afterAll(async () => {
  await fake?.close();
  await ctx.cleanup();
}, 30_000);

describe("connection operations keep their HTTP responses byte for byte", () => {
  test("list before anything is connected", async () => {
    record("http.list.empty", await http("GET", "/v1/connections"));
  });

  test("discover", async () => {
    record(
      "http.discover",
      await http("POST", "/v1/connections/discover", { base_url: fake.baseUrl }),
    );
    record(
      "http.discover.unreachable",
      await http("POST", "/v1/connections/discover", { base_url: "not a url" }),
    );
    record("http.discover.invalid", await http("POST", "/v1/connections/discover", {}));
  });

  test("start, callback and the connection views", async () => {
    const started = await http("POST", "/v1/connections/start", {
      name: "Golden",
      base_url: fake.baseUrl,
      scopes: ["read"],
    });
    record("http.start", started);
    record(
      "http.callback",
      await approve((started.body as { authorization_url: string }).authorization_url),
    );
    record(
      "http.start.taken",
      await http("POST", "/v1/connections/start", {
        name: "Golden",
        base_url: fake.baseUrl,
        scopes: ["read"],
      }),
    );
    record(
      "http.start.invalid",
      await http("POST", "/v1/connections/start", { name: "", base_url: fake.baseUrl, scopes: [] }),
    );
    const listed = await http("GET", "/v1/connections");
    connectionId = (listed.body as { items: { id: string }[] }).items[0]?.id ?? "";
    record("http.list", listed);
    record("http.get", await http("GET", `/v1/connections/${connectionId}`));
    record("http.get.missing", await http("GET", `/v1/connections/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/connections/nope"));
  });

  test("renew", async () => {
    const renewed = await http("POST", `/v1/connections/${connectionId}/renew`);
    record("http.renew", renewed);
    record(
      "http.renew.callback",
      await approve((renewed.body as { authorization_url: string }).authorization_url),
    );
    record("http.renew.missing", await http("POST", `/v1/connections/${MISSING}/renew`));
    record("http.renew.invalid", await http("POST", "/v1/connections/nope/renew"));
  });

  test("the callback stays an unauthenticated browser page", async () => {
    record(
      "http.callback.no-state",
      await http("GET", "/v1/connections/callback", undefined, null),
    );
    record(
      "http.callback.unknown-state",
      await http("GET", "/v1/connections/callback?state=unknown&code=x", undefined, null),
    );
    record(
      "http.callback.denied-key",
      await http("GET", "/v1/connections/callback?state=unknown", undefined, deniedKey),
    );
  });

  test("permission is checked before the body is validated", async () => {
    const id = connectionId;
    record("http.denied.list", await http("GET", "/v1/connections", undefined, deniedKey));
    record("http.denied.discover", await http("POST", "/v1/connections/discover", {}, deniedKey));
    record("http.denied.start", await http("POST", "/v1/connections/start", {}, deniedKey));
    record("http.denied.get", await http("GET", `/v1/connections/${id}`, undefined, deniedKey));
    record(
      "http.denied.renew",
      await http("POST", `/v1/connections/${id}/renew`, undefined, deniedKey),
    );
    record(
      "http.denied.delete",
      await http("DELETE", `/v1/connections/${id}`, undefined, deniedKey),
    );
    record("http.denied.head.list", await http("HEAD", "/v1/connections", undefined, deniedKey));
    record(
      "http.denied.head.get",
      await http("HEAD", `/v1/connections/${id}`, undefined, deniedKey),
    );
    record(
      "http.denied.head.discover",
      await http("HEAD", "/v1/connections/discover", undefined, deniedKey),
    );
    record("http.denied.other-method.list", await http("POST", "/v1/connections", {}, deniedKey));
    record(
      "http.denied.other-method.get",
      await http("PUT", `/v1/connections/${id}`, {}, deniedKey),
    );
    record(
      "http.denied.other-method.discover",
      await http("GET", "/v1/connections/discover", undefined, deniedKey),
    );
    record(
      "http.denied.other-method.start",
      await http("GET", "/v1/connections/start", undefined, deniedKey),
    );
    record(
      "http.denied.other-method.renew",
      await http("GET", `/v1/connections/${id}/renew`, undefined, deniedKey),
    );
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("unauthenticated requests are refused", async () => {
    record("http.unauthenticated.list", await http("GET", "/v1/connections", undefined, null));
    record(
      "http.unauthenticated.delete",
      await http("DELETE", `/v1/connections/${connectionId}`, undefined, null),
    );
  });

  test("delete", async () => {
    record("http.delete", await http("DELETE", `/v1/connections/${connectionId}`));
    record("http.delete.again", await http("DELETE", `/v1/connections/${connectionId}`));
    record("http.delete.invalid", await http("DELETE", "/v1/connections/nope"));
    record("http.list.after-delete", await http("GET", "/v1/connections"));
  });

  test("audit trail of the connection", async () => {
    recordRows("http.audit", await auditRows(like(auditLog.action, "connection.%")));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
