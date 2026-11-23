import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ChatAdapterRegistry } from "../../chat/registry.ts";
import { SlackAdapter } from "../../chat/slack/adapter.ts";
import { computeSlackSignature } from "../../chat/slack/verifier.ts";
import { auditLog, chatIdentities, chatWorkspaces, toolApprovals } from "../../db/schema/index.ts";
import { createApp } from "../../http/server.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { requestApproval } from "../../tools/approval.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

const SECRET = "journey-signing-secret";
const TEAM = "T_JOURNEY";
const SLACK_USER = "U_JOURNEY";
const NOW_SECONDS = 1_795_428_000;
const nextUuid = createDeterministicUuidFactory(0x5a1c);

let ctx: JourneyCtx;
let engineUrl = "";
let approvalId = "";
const slackCalls: Array<{ path: string; body: string }> = [];
const servers: Array<ReturnType<typeof serve>> = [];

function listen(fetch: (req: Request) => Response | Promise<Response>): Promise<string> {
  return new Promise((resolve) => {
    const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve(`http://127.0.0.1:${info.port}`),
    );
    servers.push(server);
  });
}

function interactionBody(action_ts: string): string {
  const payload = {
    type: "block_actions",
    team: { id: TEAM },
    user: { id: SLACK_USER },
    channel: { id: "C_JOURNEY" },
    trigger_id: `trigger-${action_ts}`,
    container: { type: "message", message_ts: "1795427000.000100", channel_id: "C_JOURNEY" },
    message: {
      ts: "1795427000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Held run*" } }],
    },
    actions: [
      {
        type: "button",
        block_id: "sk_decision",
        action_id: `sk_decide:approve:tool_approval:${approvalId}`,
        value: "/cockpit/tasks/journey",
        action_ts,
      },
    ],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function post(body: string, signature: { ts: number; secret?: string }): Promise<Response> {
  const ts = String(signature.ts);
  return fetch(`${engineUrl}/v1/chat/slack/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": computeSlackSignature(signature.secret ?? SECRET, ts, body),
    },
    body,
  });
}

async function approval() {
  const [row] = await ctx.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, ctx.tenantId), eq(toolApprovals.id, approvalId)));
  return row;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("slack-decision-buttons");
  const slack = new Hono();
  slack.post("*", async (c) => {
    slackCalls.push({ path: c.req.path, body: await c.req.text() });
    return c.json({ ok: true, ts: "1795427000.000100" });
  });
  const slackUrl = await listen(slack.fetch);

  const chatRegistry = new ChatAdapterRegistry();
  chatRegistry.register(
    { tenant_id: ctx.tenantId, platform: "slack", workspace_id: TEAM },
    new SlackAdapter({
      signingSecret: SECRET,
      botToken: "xoxb-journey",
      slackApiUrl: `${slackUrl}/api/`,
      now: () => NOW_SECONDS * 1000,
    }),
  );
  const app = createApp({ db: ctx.db, boss: ctx.boss, chatRegistry, chatEnqueue: async () => {} });
  engineUrl = await listen(app.fetch);

  await ctx.db.insert(chatWorkspaces).values({
    tenant_id: ctx.tenantId,
    platform: "slack",
    workspace_id: TEAM,
    bot_ciphertext: Buffer.from(ctx.random.bytes(8)),
    bot_iv: Buffer.from(ctx.random.bytes(8)),
    bot_auth_tag: Buffer.from(ctx.random.bytes(8)),
  });
  await ctx.db.insert(chatIdentities).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    platform: "slack",
    workspace_id: TEAM,
    platform_user_id: SLACK_USER,
  });
  approvalId = nextUuid();
  await requestApproval({
    db: ctx.db,
    principal: {
      provider: "test",
      kind: "user",
      id: ctx.userId,
      tenant_id: ctx.tenantId,
      roles: ["admin"],
    },
    approval_id: approvalId,
    tool: "run_workflow",
    surface: "mcp",
    via: "mcp",
    reason: "held_writes",
    execution_mode: "prod",
    args: { workflow: "mail-outbox" },
  });
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("a held run is decided from a Slack message", () => {
  test("requests with a wrong signature or an old timestamp decide nothing", async () => {
    const body = interactionBody("1795428000.000001");
    const forged = await post(body, { ts: NOW_SECONDS, secret: "not-the-secret" });
    expect(forged.status).toBe(401);
    const stale = await post(body, { ts: NOW_SECONDS - 10 * 60 });
    expect(stale.status).toBe(401);
    expect((await approval())?.granted_at).toBeNull();
    expect(slackCalls).toHaveLength(0);
  });

  test("a signed click by the linked person approves once and updates the Slack message", async () => {
    const body = interactionBody("1795428000.000002");
    const response = await post(body, { ts: NOW_SECONDS });
    expect(response.status).toBe(200);

    const row = await approval();
    expect(row?.granted_by_user_id).toBe(ctx.userId);
    expect(row?.granted_via).toBe("chat");

    const updates = slackCalls.filter((call) => call.path.endsWith("chat.update"));
    expect(updates).toHaveLength(1);
    const update = new URLSearchParams(updates[0]?.body ?? "");
    expect(update.get("channel")).toBe("C_JOURNEY");
    expect(update.get("ts")).toBe("1795427000.000100");
    expect(update.get("text")).toContain(`<@${SLACK_USER}>`);
    expect(update.get("blocks") ?? "").not.toContain("sk_decide:");

    const replay = await post(body, { ts: NOW_SECONDS });
    expect(replay.status).toBe(200);
    expect(slackCalls.filter((call) => call.path.endsWith("chat.update"))).toHaveLength(1);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, approvalId),
          eq(auditLog.action, "approval.granted"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_id).toBe(ctx.userId);
    expect(audits[0]?.metadata).toMatchObject({ source: "slack", slack_user_id: SLACK_USER });
  });
});
