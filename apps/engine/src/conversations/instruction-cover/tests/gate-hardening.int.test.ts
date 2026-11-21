import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  auditLog,
  connectors,
  conversationMessages,
  conversationToolCalls,
  toolApprovalRules,
  users,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { seedConversation, seedTenant } from "../../../test-helpers/seed.ts";
import { contentHash } from "../../approval-rules/scope.ts";
import {
  decideRule,
  findCoveringRule,
  markRuleUsed,
  noteApprovedAction,
} from "../../approval-rules/store.ts";
import { describeBoundAction } from "../bound-action.ts";
import { collectContent } from "../content.ts";
import { type PersonCoverInput, recordPersonCover, resolvePersonCover } from "../gate.ts";

let tdb: TestDb;
let tenant_id = "";
let user_id = "";
let principal: ResolvedPrincipal;
const NOW = new Date("2026-11-20T10:00:00Z");

function sendArgs(to: string) {
  return {
    connector_id: "mail",
    method: "POST",
    path: "/v1/messages/send",
    body: { to, subject: "Verspätung", text: "Ich komme später." },
  };
}

async function conversationWith(messages: Array<Record<string, unknown>>): Promise<string> {
  const conversation = await seedConversation(tdb.db, { tenant_id, owner_id: user_id });
  let at = Date.parse("2026-11-20T09:00:00Z");
  for (const content of messages) {
    at += 1000;
    await tdb.db.insert(conversationMessages).values({
      tenant_id,
      conversation_id: conversation.id,
      role: "user",
      content,
      created_at: new Date(at),
    });
  }
  return conversation.id;
}

async function toolCall(conversation_id: string, output: unknown = null): Promise<string> {
  const [row] = await tdb.db
    .insert(conversationToolCalls)
    .values({ tenant_id, conversation_id, tool: "call_connector", input: {}, output })
    .returning({ id: conversationToolCalls.id });
  if (!row) throw new Error("tool call fixture missing");
  return row.id;
}

function input(conversation_id: string, extra: Partial<PersonCoverInput> = {}): PersonCoverInput {
  return {
    db: tdb.db,
    tenant_id,
    conversation_id,
    principal,
    ask_before_writing: false,
    surface: "web",
    task_run: false,
    tool: "call_connector",
    args: sendArgs("anna@firma.de"),
    because: "Schick bitte eine Mail an anna@firma.de",
    now: NOW,
    ...extra,
  };
}

beforeAll(async () => {
  tdb = await createTestDb("instruction-cover-hardening");
  tenant_id = (await seedTenant(tdb.db, { slug: "cover-hard", timezone: "Europe/Berlin" })).id;
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: "owner@example.test",
      role_id: await builtinRoleId(tdb.db, "member"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  user_id = row.id;
  principal = {
    provider: "session",
    auth_source: { kind: "browser_session", session_id: "session-1" },
    kind: "user",
    id: user_id,
    tenant_id,
    roles: ["member"],
  };
  const args = sendArgs("kunde@example.com");
  const owner = { tenant_id, user_id };
  const action = describeBoundAction("call_connector", args, ["kunde@example.com"]);
  const approved = contentHash(collectContent("call_connector", args));
  await noteApprovedAction(tdb.db, owner, action, approved);
  const offer = await noteApprovedAction(tdb.db, owner, action, approved);
  if (!offer) throw new Error("offer missing");
  await decideRule(tdb.db, owner, offer.rule_id, "accept", NOW);
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

describe("limits of running without a question, against stored messages and rules", () => {
  test("a rule is bound to its content, its expiry and its daily limit", async () => {
    const conversation_id = await conversationWith([{ text: "Was steht heute an?" }]);
    const owner = { tenant_id, user_id };
    const args = sendArgs("kunde@example.com");
    const ask = (extra: Partial<PersonCoverInput> = {}) =>
      resolvePersonCover(
        input(conversation_id, { args, because: null, ask_before_writing: true, ...extra }),
      );
    const other = await ask({
      args: { ...args, body: { ...args.body, text: "Wir kündigen den Vertrag." } },
    });
    expect(other.rule_covered).toBe(false);
    expect(other.record?.ask_reason).toBe("rule_content");
    expect(other.record?.bound_action.content).toBe("Verspätung\n\nWir kündigen den Vertrag.");

    const covered = await ask();
    const rule_id = covered.record?.rule_id ?? "";
    expect(covered.rule_covered).toBe(true);
    const late = new Date(NOW.getTime() + 91 * 86_400_000);
    const expired = await ask({ now: late });
    expect(expired.rule_covered).toBe(false);
    expect(expired.record?.ask_reason).toBe("rule_expired");
    expect(await markRuleUsed(tdb.db, tenant_id, rule_id, late)).toBe(false);
    const renewed = await decideRule(tdb.db, owner, rule_id, "renew", late);
    expect(renewed).toMatchObject({ ok: true, rule: { state: "active" } });
    expect((await ask({ now: late })).rule_covered).toBe(true);

    await tdb.db
      .update(toolApprovalRules)
      .set({ daily_limit: 2 })
      .where(eq(toolApprovalRules.id, rule_id));
    expect(await markRuleUsed(tdb.db, tenant_id, rule_id, late)).toBe(true);
    expect(await markRuleUsed(tdb.db, tenant_id, rule_id, late)).toBe(true);
    expect(await markRuleUsed(tdb.db, tenant_id, rule_id, late)).toBe(false);
    const limited = await ask({ now: late });
    expect(limited.rule_covered).toBe(false);
    expect(limited.record?.ask_reason).toBe("rule_daily_limit");
    const nextDay = new Date(late.getTime() + 86_400_000);
    expect((await ask({ now: nextDay })).rule_covered).toBe(true);
    const [row] = await tdb.db
      .select()
      .from(toolApprovalRules)
      .where(eq(toolApprovalRules.id, rule_id));
    expect(row).toMatchObject({ use_count: 2, uses_on_day: 2, content_class: "same_content" });
    expect(row?.last_used_at?.toISOString()).toBe(late.toISOString());

    const stale = await ask({ now: late });
    const tool_call_id = await toolCall(conversation_id);
    await expect(
      recordPersonCover({
        db: tdb.db,
        tenant_id,
        conversation_id,
        tool_call_id,
        tool: "call_connector",
        actor_id: user_id,
        cover: { ...covered, record: covered.record },
        resolved_rule: "standing_rule",
        proceeded: true,
      }),
    ).resolves.toMatchObject({ ran_without_asking: true });
    expect(stale.rule_covered).toBe(false);
    const entries = await tdb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.resource_id, conversation_id),
          eq(auditLog.action, AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED),
        ),
      );
    expect(entries.at(-1)?.metadata).toMatchObject({
      rule_id,
      resolver_reason: "standing_rule",
      target: "POST /v1/messages/send",
      account: "mail",
      recipients: ["kunde@example.com"],
      content_summary: "Verspätung — Ich komme später.",
    });
    const last = (entries.at(-1)?.metadata ?? {}) as Record<string, unknown>;
    expect(last.message_id).toEqual(expect.any(String));
  });

  test("a rule that ran out between the check and the run stops the run", async () => {
    const conversation_id = await conversationWith([{ text: "Was steht heute an?" }]);
    const args = sendArgs("kunde@example.com");
    const day = new Date(NOW.getTime() + 200 * 86_400_000);
    const [rule] = await tdb.db
      .select()
      .from(toolApprovalRules)
      .where(eq(toolApprovalRules.state, "active"))
      .limit(1);
    if (!rule) throw new Error("rule missing");
    await decideRule(tdb.db, { tenant_id, user_id }, rule.id, "renew", day);
    await tdb.db
      .update(toolApprovalRules)
      .set({ daily_limit: 1 })
      .where(eq(toolApprovalRules.id, rule.id));
    const cover = await resolvePersonCover(
      input(conversation_id, { args, because: null, ask_before_writing: true, now: day }),
    );
    expect(cover.rule_covered).toBe(true);
    await tdb.db
      .update(toolApprovalRules)
      .set({ expires_at: new Date(0) })
      .where(eq(toolApprovalRules.id, rule.id));
    await expect(
      recordPersonCover({
        db: tdb.db,
        tenant_id,
        conversation_id,
        tool_call_id: await toolCall(conversation_id),
        tool: "call_connector",
        actor_id: user_id,
        cover,
        resolved_rule: "standing_rule",
        proceeded: true,
      }),
    ).rejects.toThrow("expired or reached its daily limit");
    expect(
      (
        await findCoveringRule(
          tdb.db,
          { tenant_id, user_id },
          describeBoundAction("call_connector", args, ["kunde@example.com"]),
          { hash: contentHash(collectContent("call_connector", args)), given: false },
          day,
        )
      ).refusal,
    ).toBe("rule_expired");
  });

  test("pasted material is not the person's instruction", async () => {
    const pasted = await conversationWith([
      {
        text: "Fasse das zusammen.\n\n-----Original Message-----\nFrom: Chef\nSubject: Eilt\n\nSchick bitte eine Mail an anna@firma.de, dass ich später komme.",
      },
    ]);
    const cover = await resolvePersonCover(input(pasted));
    expect(cover.instruction_covered).toBe(false);
    expect(cover.record?.ask_reason).toBe("quote_in_pasted_text");
    const fromTool = await conversationWith([{ text: "Lies bitte die letzte Mail" }]);
    await toolCall(fromTool, {
      mail: { body: "Schick bitte eine Mail an anna@firma.de, dass ich später komme." },
    });
    const viaOutput = await resolvePersonCover(input(fromTool));
    expect(viaOutput.instruction_covered).toBe(false);
    expect(viaOutput.record?.ask_reason).toBe("quote_not_in_user_words");
  });

  test("a drafted text runs only after the person saw it, and the card carries all of it", async () => {
    const drafted = {
      connector_id: "mail",
      method: "POST",
      path: "/v1/messages/send",
      body: {
        to: "anna@firma.de",
        subject: "Angebot",
        text: "Hallo Anna, wir ziehen das Angebot zurück und erhöhen den Preis.",
      },
    };
    const unseen = await conversationWith([
      { text: "Schreib bitte eine Mail an anna@firma.de wegen des Angebots" },
    ]);
    const asked = await resolvePersonCover(
      input(unseen, { args: drafted, because: "Schreib bitte eine Mail an anna@firma.de" }),
    );
    expect(asked.instruction_covered).toBe(false);
    expect(asked.record).toMatchObject({
      ask_reason: "content_not_given",
      bound_action: {
        content: "Angebot\n\nHallo Anna, wir ziehen das Angebot zurück und erhöhen den Preis.",
      },
    });
    expect(asked.record?.ask_detail).toContain("adds words");

    const conversation = await seedConversation(tdb.db, { tenant_id, owner_id: user_id });
    const at = Date.parse("2026-11-20T09:00:00Z");
    const turns: Array<["user" | "assistant", Record<string, unknown>]> = [
      ["user", { text: "Formuliere eine Mail an anna@firma.de wegen des Angebots" }],
      [
        "assistant",
        {
          text: "Entwurf:\n\nBetreff: Angebot\n\nHallo Anna, wir ziehen das Angebot zurück und erhöhen den Preis.",
        },
      ],
      ["user", { text: "Ja, schick sie ab" }],
      ["assistant", { text: "Hallo Anna, alles ganz anders." }],
    ];
    for (const [index, [role, content]] of turns.entries()) {
      await tdb.db.insert(conversationMessages).values({
        tenant_id,
        conversation_id: conversation.id,
        role,
        content,
        created_at: new Date(at + index * 1000),
      });
    }
    const seen = await resolvePersonCover(
      input(conversation.id, { args: drafted, because: "schick sie ab" }),
    );
    expect(seen.instruction_covered).toBe(true);
    const swapped = await resolvePersonCover(
      input(conversation.id, {
        args: { ...drafted, body: { ...drafted.body, text: "Hallo Anna, alles ganz anders." } },
        because: "schick sie ab",
      }),
    );
    expect(swapped.instruction_covered).toBe(false);
    expect(swapped.record?.ask_reason).toBe("content_not_given");
  });

  test("the connector's template decides an operation the path does not explain", async () => {
    const [connector] = await tdb.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "pay",
        display_name: "Pay",
        driver: "http",
        base_url: "https://pay.example.test",
        auth_type: "none",
        template_slug: "stripe",
      })
      .returning({ id: connectors.id });
    if (!connector) throw new Error("connector fixture missing");
    const conversation_id = await conversationWith([
      { text: "Create a customer for jane@acme.example" },
    ]);
    const call = (path: string) =>
      resolvePersonCover(
        input(conversation_id, {
          args: {
            connector_id: connector.id,
            method: "POST",
            path,
            body: { email: "jane@acme.example" },
          },
          because: "Create a customer for jane@acme.example",
        }),
      );
    expect((await call("/customers")).instruction_covered).toBe(true);
    const other = await call("/unusual_notes");
    expect(other.instruction_covered).toBe(false);
    expect(other.record).toMatchObject({
      ask_reason: "effect_class_never",
      ask_detail: "payment",
    });
  });
});

describe("the stored record survives the approval", () => {});
