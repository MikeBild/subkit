import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { conversationToolCalls, toolApprovalRules, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/index.ts";
import { seedConversation, seedTenant } from "../../../test-helpers/seed.ts";
import type { AnswerActor } from "../../answer-actor.ts";
import { toolCallPolicyView } from "../../instruction-cover/view.ts";
import { noteApprovalForRuleOffer } from "../offer.ts";

const otherPerson = createDeterministicUuidFactory(4711);

let tdb: TestDb;
let tenant_id = "";
let conversation_id = "";
let approver: ResolvedPrincipal;

const args = {
  connector_id: "mail",
  method: "POST",
  path: "/v1/messages/send",
  body: { to: ["kunde@example.com"], subject: "Bericht", text: "Anbei." },
};

async function approvedCall(): Promise<string> {
  const [row] = await tdb.db
    .insert(conversationToolCalls)
    .values({
      tenant_id,
      conversation_id,
      tool: "call_connector",
      input: args,
      confirmation_data: {
        policy: {
          ran_without_asking: false,
          rule: null,
          bound_action: {
            verb: "send",
            effect_class: "ordinary",
            target: "POST /v1/messages/send",
            account: "mail",
            recipients: ["kunde@example.com"],
            content_summary: "Bericht — Anbei.",
          },
          because: null,
          rule_id: null,
          ask_reason: "no_quote",
        },
      },
    })
    .returning({ id: conversationToolCalls.id });
  if (!row) throw new Error("tool call fixture missing");
  return row.id;
}

async function note(extra: {
  answer_actor?: AnswerActor;
  unattended?: boolean;
  tool?: string;
  callArgs?: Record<string, unknown>;
}) {
  const tool_call_id = await approvedCall();
  await noteApprovalForRuleOffer({
    db: tdb.db,
    tenant_id,
    approver,
    answer_actor: extra.answer_actor ?? { kind: "human", user_id: approver.id, via: "chat" },
    unattended: extra.unattended ?? false,
    tool: extra.tool ?? "call_connector",
    args: extra.callArgs ?? args,
    tool_call_id,
  });
  const [stored] = await tdb.db
    .select({ confirmation_data: conversationToolCalls.confirmation_data })
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.id, tool_call_id));
  return toolCallPolicyView(stored?.confirmation_data);
}

beforeAll(async () => {
  tdb = await createTestDb("approval-rules-offer");
  tenant_id = (await seedTenant(tdb.db, { slug: "rules-offer" })).id;
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: "approver@example.test",
      role_id: await builtinRoleId(tdb.db, "member"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  approver = { provider: "session", kind: "user", id: row.id, tenant_id, roles: ["member"] };
  conversation_id = (await seedConversation(tdb.db, { tenant_id, owner_id: row.id })).id;
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

describe("the offer to store a rule after an approval", () => {
  test("approvals by a machine, in a task run or of a deletion are not counted", async () => {
    expect(
      (await note({ answer_actor: { kind: "relay", reason: "model_tool_call" } }))?.rule_offer,
    ).toBeNull();
    expect((await note({ unattended: true }))?.rule_offer).toBeNull();
    expect(
      (
        await note({
          answer_actor: { kind: "human", user_id: otherPerson(), via: "portal" },
        })
      )?.rule_offer,
    ).toBeNull();
    expect(
      (
        await note({
          callArgs: { connector_id: "desk", method: "DELETE", path: "/tickets/1" },
        })
      )?.rule_offer,
    ).toBeNull();
    expect(await tdb.db.select().from(toolApprovalRules)).toEqual([]);
  });

  test("the second approval of the same action carries the offer, later ones do not", async () => {
    expect((await note({}))?.rule_offer).toBeNull();
    const second = await note({});
    expect(second?.rule_offer).toMatchObject({
      tool: "call_connector",
      verb: "send",
      target: "POST /v1/messages/send",
      account: "mail",
      recipients: ["kunde@example.com"],
    });
    expect(second?.bound_action.recipients).toEqual(["kunde@example.com"]);
    expect((await note({}))?.rule_offer).toBeNull();
    const rules = await tdb.db.select().from(toolApprovalRules);
    expect(rules.map((rule) => [rule.id, rule.state, rule.approvals_count])).toEqual([
      [second?.rule_offer?.rule_id ?? "", "offered", 3],
    ]);
  });
});
