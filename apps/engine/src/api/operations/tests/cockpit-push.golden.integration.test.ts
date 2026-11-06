import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { auditLog } from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";

const GOLDEN_PATH = new URL("./fixtures/cockpit-push.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const DEVICE = "5d5d5d5d-5d5d-4d5d-8d5d-5d5d5d5d5d5d";

let ctx: HttpTestServer;

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(/"public_key":"[A-Za-z0-9_-]{87}"/g, '"public_key":"<vapid-key>"')
    .replace(UUID, "<id>");
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; content_type: string | null; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    content_type: res.headers.get("content-type"),
    body: text ? JSON.parse(text) : null,
  };
}

function subscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from("3".padStart(64, "0"), "hex"));
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 9).toString("base64url"),
    },
  };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_cockpit_push_golden");
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 60_000);

describe("cockpit push routes keep their HTTP responses byte for byte", () => {
  test("credentials without a Cockpit session are refused", async () => {
    const bearer = { authorization: `Bearer ${ctx.apiKey}` };
    const valid = JSON.stringify(subscription("https://fcm.googleapis.com/fcm/send/golden-bearer"));
    record("http.status.api-key", await http("GET", "/v1/cockpit/push-subscription", bearer));
    record(
      "http.prepare.api-key",
      await http("POST", "/v1/cockpit/push-subscription/prepare", bearer, "{}"),
    );
    record(
      "http.update.api-key",
      await http("PUT", "/v1/cockpit/push-subscription", bearer, valid),
    );
    record(
      "http.update.api-key.invalid",
      await http("PUT", "/v1/cockpit/push-subscription", bearer, "{}"),
    );
    record("http.delete.api-key", await http("DELETE", "/v1/cockpit/push-subscription", bearer));
    record(
      "http.status.api-key.invalid-device",
      await http("GET", "/v1/cockpit/push-subscription?device=nope", bearer),
    );
    record("http.status.unauthenticated", await http("GET", "/v1/cockpit/push-subscription", {}));
  });

  test("a root Cockpit session prepares, stores, reads and removes its subscription", async () => {
    const root = await browserSessionHeaders(ctx, ctx.userId);
    const valid = subscription("https://fcm.googleapis.com/fcm/send/golden-root");
    const path = "/v1/cockpit/push-subscription";
    record("http.status.initial", await http("GET", path, root));
    record("http.status.device", await http("GET", `${path}?device=${DEVICE}`, root));
    record("http.status.invalid-device", await http("GET", `${path}?device=nope`, root));
    record("http.status.unknown-query", await http("GET", `${path}?other=1`, root));
    record("http.prepare", await http("POST", `${path}/prepare`, root, "{}"));
    record(
      "http.update.invalid-key",
      await http(
        "PUT",
        path,
        root,
        JSON.stringify({ ...valid, keys: { ...valid.keys, p256dh: "a".repeat(64) } }),
      ),
    );
    record("http.update.not-json", await http("PUT", path, root, "nope"));
    record(
      "http.update.extra-field",
      await http("PUT", path, root, JSON.stringify({ ...valid, x: 1 })),
    );
    record(
      "http.update.blocked-endpoint",
      await http("PUT", path, root, JSON.stringify(subscription("https://127.0.0.1/push"))),
    );
    record(
      "http.update.rebind-unbound",
      await http("PUT", path, root, JSON.stringify({ ...valid, rebind: true })),
    );
    record("http.update", await http("PUT", path, root, JSON.stringify(valid)));
    record(
      "http.update.device",
      await http("PUT", path, root, JSON.stringify({ ...valid, device: DEVICE })),
    );
    record(
      "http.update.rebind",
      await http("PUT", path, root, JSON.stringify({ ...valid, rebind: true })),
    );
    record("http.status.active", await http("GET", path, root));
    record("http.status.active.device", await http("GET", `${path}?device=${DEVICE}`, root));
    record("http.delete", await http("DELETE", path, root));
    record("http.delete.again", await http("DELETE", path, root));
    record("http.status.removed", await http("GET", path, root));
  });

  test("an installation path refuses the root Cockpit session", async () => {
    const root = await browserSessionHeaders(ctx, ctx.userId);
    const created = await fetch(`${ctx.baseUrl}/v1/cockpit/installations`, {
      method: "POST",
      headers: root,
      body: "{}",
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const base = `/cockpit/i/${id}/api/v1/cockpit/push-subscription`;
    record("http.installation.status.root", await http("GET", base, root));
    record("http.installation.prepare.root", await http("POST", `${base}/prepare`, root, "{}"));
    record(
      "http.installation.update.root",
      await http(
        "PUT",
        base,
        root,
        JSON.stringify(subscription("https://fcm.googleapis.com/fcm/send/golden-installation")),
      ),
    );
    record("http.installation.delete.root", await http("DELETE", base, root));
  });

  test("audit rows of the push routes", async () => {
    const rows = await ctx.db
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
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), like(auditLog.action, "cockpit_push.%")));
    actual.audit = JSON.stringify(rows.map((row) => scrub(row)).sort());
    expect(actual.audit).toBe(golden.audit as string);
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
