import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  cliNotificationInbox,
  notificationDeliveries,
  users,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/notifications.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let systemKey: string;
let channelId: string;
let ruleId: string;
const inboxIds: number[] = [];

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
  ctx = await createHttpTestServer("operations_notifications_golden");
  const deniedUser = await seedUser(
    "denied-notifications-operations@test.local",
    await emptyRoleId(ctx.db, ctx.tenantId),
  );
  deniedKey = await mintKey({ user_id: deniedUser }, 0x9a_01);
  systemKey = await mintKey({ system_account_id: ctx.systemAccountId }, 0x9a_02);
  for (const [index, actionable] of [false, true, false].entries()) {
    const [row] = await ctx.db
      .insert(cliNotificationInbox)
      .values({
        tenant_id: ctx.tenantId,
        severity: index === 1 ? "error" : "info",
        event_type: `golden.event.${index}`,
        event_payload: { index },
        actionable,
        created_at: new Date(FROZEN_NOW + index * 60_000),
      })
      .returning({ id: cliNotificationInbox.id });
    if (!row) throw new Error("inbox insert returned no row");
    inboxIds.push(row.id);
  }
  await ctx.db.insert(notificationDeliveries).values([
    {
      tenant_id: ctx.tenantId,
      event_type: "execution.failed",
      severity: "error",
      status: "sent",
      created_at: new Date(FROZEN_NOW),
    },
    {
      tenant_id: ctx.tenantId,
      event_type: "execution.failed",
      severity: "warn",
      status: "rate_limited",
      reason: "rate_limit",
      created_at: new Date(FROZEN_NOW + 60_000),
    },
  ]);
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("notification operations keep their HTTP responses byte for byte", () => {
  test("channels", async () => {
    record("http.channels.empty", await http("GET", "/v1/notifications/channels"));
    const created = await http("POST", "/v1/notifications/channels", {
      workspace_id: "T-golden",
      channel_id: "C-golden",
      platform: "slack",
    });
    channelId = (created.body as { id: string }).id;
    record("http.channels.create", created);
    record(
      "http.channels.create.full",
      await http("POST", "/v1/notifications/channels", {
        workspace_id: "T-golden",
        channel_id: "C-second",
        platform: "slack",
        default_severity: "warn",
        rate_limit_per_minute: 5,
        active: false,
      }),
    );
    record(
      "http.channels.create.invalid",
      await http("POST", "/v1/notifications/channels", { workspace_id: "" }),
    );
    record("http.channels.list", await http("GET", "/v1/notifications/channels"));
    record(
      "http.channels.update",
      await http("PATCH", `/v1/notifications/channels/${channelId}`, {
        default_severity: "error",
        rate_limit_per_minute: 10,
      }),
    );
    record(
      "http.channels.update.empty",
      await http("PATCH", `/v1/notifications/channels/${channelId}`, {}),
    );
    record(
      "http.channels.update.missing",
      await http("PATCH", `/v1/notifications/channels/${MISSING}`, { active: false }),
    );
    record(
      "http.channels.update.invalid",
      await http("PATCH", `/v1/notifications/channels/${channelId}`, { rate_limit_per_minute: 0 }),
    );
  });

  test("rules", async () => {
    record("http.rules.empty", await http("GET", "/v1/notifications/rules"));
    const created = await http("POST", "/v1/notifications/rules", {
      name: "Golden failures",
      event_pattern: "execution.failed",
      target_workspace_id: "T-golden",
      target_channel_id: "C-golden",
    });
    ruleId = (created.body as { id: string }).id;
    record("http.rules.create", created);
    record(
      "http.rules.create.full",
      await http("POST", "/v1/notifications/rules", {
        name: "Golden filtered",
        event_pattern: "workflow.*",
        workflow_pattern: "golden-*",
        severity: "warn",
        request_source_filter: ["api", "ui"],
        target_workspace_id: "T-golden",
        target_channel_id: "C-second",
        active: false,
      }),
    );
    record("http.rules.create.invalid", await http("POST", "/v1/notifications/rules", {}));
    record("http.rules.list", await http("GET", "/v1/notifications/rules"));
    record(
      "http.rules.update",
      await http("PATCH", `/v1/notifications/rules/${ruleId}`, {
        severity: "critical",
        request_source_filter: null,
      }),
    );
    record(
      "http.rules.update.missing",
      await http("PATCH", `/v1/notifications/rules/${MISSING}`, { active: false }),
    );
    record(
      "http.rules.update.invalid",
      await http("PATCH", `/v1/notifications/rules/${ruleId}`, { severity: "loud" }),
    );
    record("http.rules.test", await http("POST", `/v1/notifications/rules/${ruleId}/test`, {}));
    record(
      "http.rules.test.matched",
      await http("POST", `/v1/notifications/rules/${ruleId}/test`, {
        event_type: "execution.started",
        severity: "info",
        payload: { golden: true },
      }),
    );
    record(
      "http.rules.test.invalid",
      await http("POST", `/v1/notifications/rules/${ruleId}/test`, { event_type: "" }),
    );
    record(
      "http.rules.test.missing",
      await http("POST", `/v1/notifications/rules/${MISSING}/test`, {}),
    );
  });

  test("deliveries", async () => {
    record("http.deliveries", await http("GET", "/v1/notifications/deliveries"));
    record(
      "http.deliveries.page",
      await http("GET", "/v1/notifications/deliveries?limit=1&offset=1"),
    );
    record(
      "http.deliveries.status",
      await http("GET", "/v1/notifications/deliveries?status=rate_limited"),
    );
    record("http.deliveries.invalid", await http("GET", "/v1/notifications/deliveries?limit=0"));
  });

  test("inbox", async () => {
    const [first, second, third] = inboxIds;
    record("http.inbox", await http("GET", "/v1/notifications/inbox"));
    record(
      "http.inbox.actionable",
      await http("GET", "/v1/notifications/inbox?actionable_only=true"),
    );
    record(
      "http.inbox.read",
      await http("POST", "/v1/notifications/inbox/read", { ids: [second] }),
    );
    record("http.inbox.unread-only", await http("GET", "/v1/notifications/inbox?unread_only=true"));
    record(
      "http.inbox.unread",
      await http("POST", "/v1/notifications/inbox/unread", { ids: [second] }),
    );
    record(
      "http.inbox.ack",
      await http("POST", "/v1/notifications/inbox/ack", { up_to_cursor: first }),
    );
    record("http.inbox.since", await http("GET", `/v1/notifications/inbox?since=${first}&limit=1`));
    record("http.inbox.ack.invalid", await http("POST", "/v1/notifications/inbox/ack", {}));
    record(
      "http.inbox.read.invalid",
      await http("POST", "/v1/notifications/inbox/read", { ids: [] }),
    );
    record("http.inbox.system", await http("GET", "/v1/notifications/inbox", undefined, systemKey));
    record(
      "http.inbox.system.ack",
      await http("POST", "/v1/notifications/inbox/ack", { up_to_cursor: third }, systemKey),
    );
    record(
      "http.inbox.system.read",
      await http("POST", "/v1/notifications/inbox/read", { ids: [third] }, systemKey),
    );
    record(
      "http.inbox.system.unread",
      await http("POST", "/v1/notifications/inbox/unread", { ids: [third] }, systemKey),
    );
  });

  test("permission is checked before the body is validated", async () => {
    const calls: [string, string, unknown][] = [
      ["GET", "/v1/notifications/channels", undefined],
      ["POST", "/v1/notifications/channels", {}],
      ["PATCH", `/v1/notifications/channels/${channelId}`, {}],
      ["DELETE", `/v1/notifications/channels/${channelId}`, undefined],
      ["GET", "/v1/notifications/rules", undefined],
      ["POST", "/v1/notifications/rules", {}],
      ["PATCH", `/v1/notifications/rules/${ruleId}`, {}],
      ["DELETE", `/v1/notifications/rules/${ruleId}`, undefined],
      ["POST", `/v1/notifications/rules/${ruleId}/test`, {}],
      ["GET", "/v1/notifications/deliveries", undefined],
      ["GET", "/v1/notifications/inbox", undefined],
      ["POST", "/v1/notifications/inbox/ack", {}],
      ["POST", "/v1/notifications/inbox/read", {}],
      ["POST", "/v1/notifications/inbox/unread", {}],
      ["HEAD", "/v1/notifications/channels", undefined],
      ["HEAD", "/v1/notifications/rules", undefined],
      ["HEAD", "/v1/notifications/deliveries", undefined],
      ["HEAD", "/v1/notifications/inbox", undefined],
      ["PUT", "/v1/notifications/channels", {}],
      ["GET", `/v1/notifications/channels/${channelId}`, undefined],
      ["PUT", "/v1/notifications/rules", {}],
      ["GET", `/v1/notifications/rules/${ruleId}`, undefined],
      ["GET", `/v1/notifications/rules/${ruleId}/test`, undefined],
      ["POST", "/v1/notifications/deliveries", {}],
      ["POST", "/v1/notifications/inbox", {}],
      ["GET", "/v1/notifications/inbox/ack", undefined],
      ["GET", "/v1/notifications/inbox/read", undefined],
      ["GET", "/v1/notifications/inbox/unread", undefined],
    ];
    for (const [method, path, body] of calls) {
      const name = `${method} ${path.replace(channelId, "<channel>").replace(ruleId, "<rule>")}`;
      record(`http.denied ${name}`, await http(method, path, body, deniedKey));
    }
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("delete", async () => {
    record("http.channels.delete", await http("DELETE", `/v1/notifications/channels/${channelId}`));
    record(
      "http.channels.delete.again",
      await http("DELETE", `/v1/notifications/channels/${channelId}`),
    );
    record("http.rules.delete", await http("DELETE", `/v1/notifications/rules/${ruleId}`));
    record("http.rules.delete.again", await http("DELETE", `/v1/notifications/rules/${ruleId}`));
    record("http.rules.delete.invalid", await http("DELETE", "/v1/notifications/rules/nope"));
  });

  test("marking inbox tasks read or unread writes an audit row", async () => {
    const rows = await auditRows(eq(auditLog.resource_type, "cli_notification_inbox"));
    const readState = rows
      .filter((row) => row.action.startsWith("notification.inbox_"))
      .map((row) => {
        const { ids, marked, unmarked } = row.metadata as Record<string, unknown>;
        return { action: row.action, actor_type: row.actor_type, ids, marked, unmarked };
      })
      .sort((a, b) => a.action.localeCompare(b.action));
    expect(readState).toEqual([
      {
        action: "notification.inbox_read",
        actor_type: "user",
        ids: [inboxIds[1]],
        marked: 1,
        unmarked: undefined,
      },
      {
        action: "notification.inbox_unread",
        actor_type: "user",
        ids: [inboxIds[1]],
        marked: undefined,
        unmarked: 1,
      },
    ]);
  });

  test("audit trail of the written resources", async () => {
    recordRows("http.audit.channel", await auditRows(eq(auditLog.resource_id, channelId)));
    recordRows("http.audit.rule", await auditRows(eq(auditLog.resource_id, ruleId)));
    recordRows(
      "http.audit.inbox",
      await auditRows(eq(auditLog.resource_type, "cli_notification_inbox")),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
