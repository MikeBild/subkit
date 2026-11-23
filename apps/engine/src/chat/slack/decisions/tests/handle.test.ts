import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getConfig, loadConfig } from "../../../../config/loader.ts";
import {
  auditLog,
  chatIdentities,
  chatWorkspaces,
  toolApprovals,
  users,
} from "../../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../../db/tests/setup.ts";
import { SLACK_DECISION_COPY } from "../../../../http/i18n/slack-decisions.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../../../test-helpers/seed.ts";
import { requestApproval } from "../../../../tools/approval.ts";
import type { ChatEvent } from "../../../types.ts";
import { handleSlackDecisionInteraction, type SlackDecisionClient } from "../handle.ts";
import { verifySlackLinkToken } from "../link-token.ts";

const nextId = createDeterministicUuidFactory(0x51ac);
const nextHex = createDeterministicHexFactory(0x51ad);
const TEAM = "T_DECIDE";
const BASE = "https://subkit.example.com";
const AT = new Date("2026-11-23T10:00:00.000Z");

let testDb: TestDb;
let tenant_id: string;
let adminId: string;
let enduserId: string;

interface Recorded {
  updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }>;
  ephemerals: Array<{ channel: string; user: string; text: string; blocks: unknown[] }>;
}

function recordingClient(): SlackDecisionClient & Recorded {
  const rec: Recorded = { updates: [], ephemerals: [] };
  return {
    ...rec,
    update: async (p) => {
      rec.updates.push(p);
    },
    ephemeral: async (p) => {
      rec.ephemerals.push(p);
    },
  };
}

function click(p: {
  verb: "approve" | "decline";
  approval_id: string;
  slack_user: string;
  action_ts: string;
}): ChatEvent {
  return {
    platform: "slack",
    workspace_id: TEAM,
    channel_id: "C_OPS",
    user_id: p.slack_user,
    kind: "interaction",
    interaction: {
      action_id: `sk_decide:${p.verb}:tool_approval:${p.approval_id}`,
      value: "/cockpit/tasks/t1",
    },
    raw: {
      type: "block_actions",
      trigger_id: `trig-${p.action_ts}`,
      container: { message_ts: "1700000000.000100" },
      message: {
        ts: "1700000000.000100",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Held run*" } }],
      },
      actions: [{ action_id: "x", action_ts: p.action_ts }],
    },
  };
}

async function seedPending(): Promise<string> {
  const approval_id = nextId();
  await requestApproval({
    db: testDb.db,
    principal: { provider: "test", kind: "user", id: adminId, tenant_id, roles: ["admin"] },
    approval_id,
    tool: "run_workflow",
    surface: "mcp",
    via: "mcp",
    reason: "held_writes",
    execution_mode: "prod",
    args: { workflow: "mail-outbox" },
  });
  return approval_id;
}

async function link(user_id: string, slack_user: string): Promise<void> {
  await testDb.db.insert(chatIdentities).values({
    tenant_id,
    user_id,
    platform: "slack",
    workspace_id: TEAM,
    platform_user_id: slack_user,
  });
}

async function auditFor(approval_id: string) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, approval_id)));
}

beforeAll(async () => {
  try {
    getConfig();
  } catch {
    const dir = mkdtempSync(join(tmpdir(), "subkit-cfg-slack-decisions-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/slack-decisions", NODE_ENV: "test" },
      configPathOverride: join(dir, "subkit.config.json"),
    });
  }
  testDb = await createTestDb("slack-decisions");
  const tenant = await seedTenant(testDb.db, { slug: "t-slack-decide", display_name: "Decide" });
  tenant_id = tenant.id;
  const [admin] = await testDb.db
    .insert(users)
    .values({
      tenant_id,
      email: "ada@decide.test",
      display_name: "Ada",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  const [enduser] = await testDb.db
    .insert(users)
    .values({
      tenant_id,
      email: "eve@decide.test",
      role_id: await builtinRoleId(testDb.db, "enduser"),
    })
    .returning();
  if (!admin || !enduser) throw new Error("seed users");
  adminId = admin.id;
  enduserId = enduser.id;
  await testDb.db.insert(chatWorkspaces).values({
    tenant_id,
    platform: "slack",
    workspace_id: TEAM,
    bot_ciphertext: Buffer.from(nextHex(8), "hex"),
    bot_iv: Buffer.from(nextHex(8), "hex"),
    bot_auth_tag: Buffer.from(nextHex(8), "hex"),
  });
  await link(adminId, "U_ADA");
  await link(enduserId, "U_EVE");
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
}, 120_000);

let client: ReturnType<typeof recordingClient>;
const resumed: string[] = [];
beforeEach(() => {
  client = recordingClient();
  resumed.length = 0;
});

function deps() {
  return {
    db: testDb.db,
    client,
    publicBaseUrl: BASE,
    clock: () => AT,
    resume: async (p: { approval_id: string }) => {
      resumed.push(p.approval_id);
      return true;
    },
  };
}

describe("Slack decision buttons", () => {
  test("a linked approver approves: one audited decision and the message shows who decided", async () => {
    const approval_id = await seedPending();
    const outcome = await handleSlackDecisionInteraction(
      click({ verb: "approve", approval_id, slack_user: "U_ADA", action_ts: "1.1" }),
      deps(),
    );
    expect(outcome.handled).toBe(true);

    const [row] = await testDb.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.id, approval_id));
    expect(row?.granted_by_user_id).toBe(adminId);
    expect(row?.granted_via).toBe("chat");

    const granted = (await auditFor(approval_id)).filter(
      (entry) => entry.action === "approval.granted" && entry.result === "success",
    );
    expect(granted).toHaveLength(1);
    expect(granted[0]?.actor_id).toBe(adminId);
    expect(granted[0]?.metadata).toMatchObject({
      source: "slack",
      slack_user_id: "U_ADA",
      slack_team_id: TEAM,
      decided_via: "chat",
      decided_by_user_id: adminId,
    });

    expect(client.updates).toHaveLength(1);
    const update = client.updates[0];
    expect(update?.ts).toBe("1700000000.000100");
    expect(update?.channel).toBe("C_OPS");
    expect(update?.text).toContain("Approved by <@U_ADA> (Ada)");
    const serialized = JSON.stringify(update?.blocks);
    expect(serialized).not.toContain("sk_decide:");
    expect(serialized).toContain("*Held run*");
  });

  test("a replayed action is ignored and a second click shows the already-decided state", async () => {
    const approval_id = await seedPending();
    const first = click({ verb: "approve", approval_id, slack_user: "U_ADA", action_ts: "2.1" });
    await handleSlackDecisionInteraction(first, deps());
    await handleSlackDecisionInteraction(first, deps());
    expect(client.updates).toHaveLength(1);

    await handleSlackDecisionInteraction(
      click({ verb: "decline", approval_id, slack_user: "U_ADA", action_ts: "2.2" }),
      deps(),
    );
    expect(client.updates).toHaveLength(2);
    expect(client.updates[1]?.text).toBe(SLACK_DECISION_COPY.en.alreadyApproved("Ada"));
    const granted = (await auditFor(approval_id)).filter(
      (entry) => entry.action === "approval.granted" && entry.result === "success",
    );
    expect(granted).toHaveLength(1);
    const [row] = await testDb.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.id, approval_id));
    expect(row?.declined_at).toBeNull();
  });

  test("an expired approval shows the expired state and changes nothing", async () => {
    const approval_id = await seedPending();
    await testDb.db
      .update(toolApprovals)
      .set({ expires_at: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(toolApprovals.id, approval_id));
    await handleSlackDecisionInteraction(
      click({ verb: "approve", approval_id, slack_user: "U_ADA", action_ts: "3.1" }),
      deps(),
    );
    expect(client.updates[0]?.text).toBe(SLACK_DECISION_COPY.en.expired);
    expect(resumed).toHaveLength(0);
  });

  test("a person without the approver permission is refused at click time and audited", async () => {
    const approval_id = await seedPending();
    await handleSlackDecisionInteraction(
      click({ verb: "approve", approval_id, slack_user: "U_EVE", action_ts: "4.1" }),
      deps(),
    );
    const [row] = await testDb.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.id, approval_id));
    expect(row?.granted_at).toBeNull();
    expect(client.updates).toHaveLength(0);
    expect(client.ephemerals[0]?.user).toBe("U_EVE");
    expect(client.ephemerals[0]?.text).toBe(SLACK_DECISION_COPY.en.forbidden);
    const denied = (await auditFor(approval_id)).filter((entry) => entry.result === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.actor_id).toBe(enduserId);
    expect(denied[0]?.reason).toBe("rbac_denied");
    expect(denied[0]?.metadata).toMatchObject({ source: "slack", slack_user_id: "U_EVE" });
  });

  test("an unlinked Slack user gets the deep link and a one-time link, and nothing is decided", async () => {
    const approval_id = await seedPending();
    await handleSlackDecisionInteraction(
      click({ verb: "approve", approval_id, slack_user: "U_STRANGER", action_ts: "5.1" }),
      deps(),
    );
    const [row] = await testDb.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.id, approval_id));
    expect(row?.granted_at).toBeNull();
    const prompt = client.ephemerals[0];
    expect(prompt?.text).toBe(SLACK_DECISION_COPY.en.notLinked);
    if (!prompt) throw new Error("no link prompt was sent");
    const buttons = (
      prompt.blocks.find((b) => (b as { type: string }).type === "actions") as {
        elements: Array<{ url: string }>;
      }
    ).elements;
    expect(buttons[1]?.url).toBe(`${BASE}/cockpit/tasks/t1`);
    const linkUrl = new URL(buttons[0]?.url ?? "");
    expect(linkUrl.pathname).toBe("/v1/integrations/slack/link");
    expect(await verifySlackLinkToken(linkUrl.searchParams.get("token") ?? "")).toEqual({
      tenant_id,
      team_id: TEAM,
      slack_user_id: "U_STRANGER",
    });
    const denied = (await auditFor(approval_id)).filter((entry) => entry.result === "denied");
    expect(denied[0]?.reason).toBe("identity_not_linked");
  });

  test("the deep link button and foreign actions are acknowledged without side effects", async () => {
    const open = await handleSlackDecisionInteraction(
      {
        ...click({ verb: "approve", approval_id: nextId(), slack_user: "U_ADA", action_ts: "6.1" }),
        interaction: { action_id: "sk_open:tool_approval:abc" },
      },
      deps(),
    );
    expect(open.handled).toBe(true);
    const foreign = await handleSlackDecisionInteraction(
      {
        ...click({ verb: "approve", approval_id: nextId(), slack_user: "U_ADA", action_ts: "6.2" }),
        interaction: { action_id: "approve:abc" },
      },
      deps(),
    );
    expect(foreign.handled).toBe(false);
    expect(client.updates).toHaveLength(0);
    expect(client.ephemerals).toHaveLength(0);
  });
});
