import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  conversationMessages,
  conversations,
  systemAccounts,
  users,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/conversation-lifecycle.golden.json", import.meta.url)
  .pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let systemKey: string;
let conversationId: string;
let anchorId: string;
let otherId: string;

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

function auditRows(where: ReturnType<typeof eq | typeof like>) {
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

async function mintKey(
  owner: { user_id: string } | { system_account_id: string },
  seed: number,
  scopes: string[],
): Promise<string> {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    ...owner,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes,
  });
  return key;
}

async function seedConversation(title: string): Promise<string> {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenantId, status: "active", title, owner_id: ctx.userId })
    .returning();
  if (!row) throw new Error("conversation insert returned no row");
  return row.id;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_conversation_lifecycle_golden");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-lifecycle-operations@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = await mintKey({ user_id: denied.id }, 0x6c_01, ["*"]);
  const [account] = await ctx.db
    .insert(systemAccounts)
    .values({ tenant_id: ctx.tenantId, name: "lifecycle-golden-account" })
    .returning();
  if (!account) throw new Error("system account insert returned no row");
  systemKey = await mintKey({ system_account_id: account.id }, 0x6c_02, ["*"]);
  conversationId = await seedConversation("lifecycle-source");
  otherId = await seedConversation("lifecycle-other");
  const [first] = await ctx.db
    .insert(conversationMessages)
    .values({
      tenant_id: ctx.tenantId,
      conversation_id: conversationId,
      role: "user",
      content: { text: "first" },
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    })
    .returning();
  const [second] = await ctx.db
    .insert(conversationMessages)
    .values({
      tenant_id: ctx.tenantId,
      conversation_id: conversationId,
      role: "assistant",
      content: { text: "second" },
      created_at: new Date("2026-01-01T00:00:01.000Z"),
    })
    .returning();
  if (!first || !second) throw new Error("message insert returned no row");
  anchorId = second.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("conversation lifecycle operations keep their HTTP responses byte for byte", () => {
  test("context snapshot", async () => {
    record(
      "http.snapshot",
      await http("GET", `/v1/conversations/${conversationId}/context-snapshot`),
    );
    record(
      "http.snapshot.missing",
      await http("GET", `/v1/conversations/${MISSING}/context-snapshot`),
    );
    record("http.snapshot.invalid", await http("GET", "/v1/conversations/nope/context-snapshot"));
  });

  test("hide and unhide", async () => {
    record("http.hide", await http("POST", `/v1/conversations/${conversationId}/hide`));
    record("http.hide.again", await http("POST", `/v1/conversations/${conversationId}/hide`));
    record("http.unhide", await http("POST", `/v1/conversations/${conversationId}/unhide`));
    record("http.hide.missing", await http("POST", `/v1/conversations/${MISSING}/hide`));
    record("http.unhide.missing", await http("POST", `/v1/conversations/${MISSING}/unhide`));
    record("http.hide.invalid", await http("POST", "/v1/conversations/nope/hide"));
    record(
      "http.hide.system-account",
      await http("POST", `/v1/conversations/${conversationId}/hide`, undefined, systemKey),
    );
    record(
      "http.unhide.system-account",
      await http("POST", `/v1/conversations/${conversationId}/unhide`, undefined, systemKey),
    );
    record(
      "http.hide.empty-role",
      await http("POST", `/v1/conversations/${otherId}/hide`, undefined, deniedKey),
    );
    record(
      "http.unhide.empty-role",
      await http("POST", `/v1/conversations/${otherId}/unhide`, undefined, deniedKey),
    );
  });

  test("compact", async () => {
    record(
      "http.compact.noop",
      await http("POST", `/v1/conversations/${conversationId}/compact`, { keep_last: 10 }),
    );
    record(
      "http.compact.invalid-body",
      await http("POST", `/v1/conversations/${conversationId}/compact`, { keep_last: "x" }),
    );
    record("http.compact.invalid", await http("POST", "/v1/conversations/nope/compact", {}));
  });

  test("fork from message", async () => {
    record(
      "http.fork",
      await http("POST", `/v1/conversations/${conversationId}/fork-from-message/${anchorId}`),
    );
    record(
      "http.fork.missing-anchor",
      await http("POST", `/v1/conversations/${conversationId}/fork-from-message/${MISSING}`),
    );
    record(
      "http.fork.missing",
      await http("POST", `/v1/conversations/${MISSING}/fork-from-message/${anchorId}`),
    );
    record(
      "http.fork.invalid",
      await http("POST", `/v1/conversations/${conversationId}/fork-from-message/nope`),
    );
  });

  test("permission is checked before the body is validated", async () => {
    const id = conversationId;
    record(
      "http.denied.snapshot",
      await http("GET", `/v1/conversations/${id}/context-snapshot`, undefined, deniedKey),
    );
    record(
      "http.denied.cancel",
      await http("POST", `/v1/conversations/${id}/cancel`, undefined, deniedKey),
    );
    record(
      "http.denied.compact",
      await http("POST", `/v1/conversations/${id}/compact`, { keep_last: "x" }, deniedKey),
    );
    record(
      "http.denied.fork",
      await http("POST", `/v1/conversations/${id}/fork-from-message/${anchorId}`, {}, deniedKey),
    );
    record(
      "http.denied.delete",
      await http("DELETE", `/v1/conversations/${id}`, undefined, deniedKey),
    );
    record(
      "http.denied.head.snapshot",
      await http("HEAD", `/v1/conversations/${id}/context-snapshot`, undefined, deniedKey),
    );
    record(
      "http.denied.other-method.cancel",
      await http("GET", `/v1/conversations/${id}/cancel`, undefined, deniedKey),
    );
    record(
      "http.denied.other-method.snapshot",
      await http("POST", `/v1/conversations/${id}/context-snapshot`, {}, deniedKey),
    );
    record(
      "http.denied.other-method.hide",
      await http("GET", `/v1/conversations/${id}/hide`, undefined, deniedKey),
    );
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("unauthenticated requests are refused", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/conversations/${conversationId}/cancel`, {
      method: "POST",
    });
    record("http.unauthenticated.cancel", {
      status: res.status,
      body: parseBody(await res.text()),
    });
  });

  test("cancel and delete", async () => {
    record("http.cancel", await http("POST", `/v1/conversations/${conversationId}/cancel`));
    record("http.cancel.again", await http("POST", `/v1/conversations/${conversationId}/cancel`));
    record("http.cancel.missing", await http("POST", `/v1/conversations/${MISSING}/cancel`));
    record("http.cancel.invalid", await http("POST", "/v1/conversations/nope/cancel"));
    record(
      "http.delete.not-owner",
      await http("DELETE", `/v1/conversations/${otherId}`, undefined, systemKey),
    );
    record("http.delete", await http("DELETE", `/v1/conversations/${conversationId}`));
    record("http.delete.again", await http("DELETE", `/v1/conversations/${conversationId}`));
    record("http.delete.invalid", await http("DELETE", "/v1/conversations/nope"));
    record(
      "http.compact.missing",
      await http("POST", `/v1/conversations/${conversationId}/compact`, {}),
    );
  });

  test("audit trail of the lifecycle", async () => {
    recordRows("http.audit", await auditRows(like(auditLog.action, "conversation.%")));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
