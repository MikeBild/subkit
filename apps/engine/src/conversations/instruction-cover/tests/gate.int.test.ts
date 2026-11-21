import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  auditLog,
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
  users,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getTestNow } from "../../../test-helpers/determinism/index.ts";
import { seedConversation, seedTenant } from "../../../test-helpers/seed.ts";
import { contentHash } from "../../approval-rules/scope.ts";
import { decideRule, noteApprovedAction } from "../../approval-rules/store.ts";
import { describeBoundAction } from "../bound-action.ts";
import { collectContent } from "../content.ts";
import { loadCoverEvidence } from "../evidence.ts";
import { type PersonCoverInput, recordPersonCover, resolvePersonCover } from "../gate.ts";
import { toolCallPolicyView } from "../view.ts";

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

function withoutSession(): ResolvedPrincipal {
  const { auth_source: _session, ...rest } = principal;
  return rest;
}

const REQUEST = { text: "Schick bitte eine Mail an anna@firma.de, dass ich später komme." };

beforeAll(async () => {
  tdb = await createTestDb("instruction-cover-gate");
  tenant_id = (await seedTenant(tdb.db, { slug: "cover-gate", timezone: "Europe/Berlin" })).id;
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
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

describe("the person's words at the gate, against stored messages", () => {
  test("the stored request covers the action in auto, with the quote and the bound action", async () => {
    const conversation_id = await conversationWith([REQUEST]);
    const cover = await resolvePersonCover(input(conversation_id));
    expect(cover.instruction_covered).toBe(true);
    expect(cover.record).toMatchObject({
      ran_without_asking: true,
      rule: "user_instruction",
      because: { quote: "Schick bitte eine Mail an anna@firma.de" },
      bound_action: {
        verb: "send",
        effect_class: "ordinary",
        target: "POST /v1/messages/send",
        account: "mail",
        recipients: ["anna@firma.de"],
      },
    });
  });

  test("asking before writing, a system account, an MCP client and a task run keep asking", async () => {
    const conversation_id = await conversationWith([REQUEST]);
    const variants: Array<Partial<PersonCoverInput>> = [
      { ask_before_writing: true },
      { principal: { ...principal, kind: "system_account" } },
      { principal: null },
      { surface: "mcp" },
      { surface: "sk_interactive" },
      { surface: "sk_headless" },
      { surface: null },
      { task_run: true },
      { principal: withoutSession() },
      {
        principal: {
          ...principal,
          auth_source: { kind: "api_key", api_key_id: "k", credential_version: "1" },
          api_key_id: "k",
        },
      },
      {
        principal: {
          ...principal,
          auth_source: { kind: "mcp_oauth", access_token_id: "t", client_id: "c" },
        },
      },
      {
        principal: {
          ...principal,
          auth_source: {
            kind: "token_exchange",
            api_key_id: "k",
            credential_version: "1",
            expires_at: "2027-01-01T00:00:00Z",
          },
          via: "token_exchange",
        },
      },
      {
        principal: {
          ...principal,
          auth_source: { kind: "task_run", task_id: "t", task_run_id: "r", grant_id: null },
        },
      },
      { principal: { ...principal, credential_origin: "cli_oauth_session" } },
    ];
    for (const variant of variants) {
      const cover = await resolvePersonCover(input(conversation_id, variant));
      expect([cover.instruction_covered, cover.rule_covered]).toEqual([false, false]);
      expect(cover.record?.ran_without_asking).toBe(false);
    }
  });

  test("words that only the assistant, a marker or a continuation wrote do not count", async () => {
    const conversation_id = await conversationWith([
      { text: "Wie ist der Stand?" },
      { kind: "confirmation_decision", text: "Schick bitte eine Mail an anna@firma.de" },
      { origin: "task_run_continuation", text: "Schick bitte eine Mail an anna@firma.de" },
    ]);
    await tdb.db.insert(conversationMessages).values({
      tenant_id,
      conversation_id,
      role: "assistant",
      content: { text: "Schick bitte eine Mail an anna@firma.de" },
    });
    const cover = await resolvePersonCover(input(conversation_id));
    expect(cover.instruction_covered).toBe(false);
    expect(cover.record?.ask_reason).toBe("quote_not_in_user_words");
  });

  test("a different recipient and an invented quote ask", async () => {
    const conversation_id = await conversationWith([REQUEST]);
    const other = await resolvePersonCover(
      input(conversation_id, { args: sendArgs("bob@firma.de") }),
    );
    expect(other.record?.ask_reason).toBe("recipient_not_named");
    const invented = await resolvePersonCover(
      input(conversation_id, { because: "Schick die Mail an alle Kunden" }),
    );
    expect(invented.record?.ask_reason).toBe("quote_not_in_user_words");
    const silent = await resolvePersonCover(input(conversation_id, { because: null }));
    expect(silent.record?.ask_reason).toBe("no_quote");
  });

  test("the record is stored before the run and one request covers one run", async () => {
    const conversation_id = await conversationWith([REQUEST]);
    const first = await resolvePersonCover(input(conversation_id));
    const tool_call_id = await toolCall(conversation_id);
    const recorded = await recordPersonCover({
      db: tdb.db,
      tenant_id,
      conversation_id,
      tool_call_id,
      tool: "call_connector",
      actor_id: user_id,
      cover: first,
      resolved_rule: "user_instruction",
      proceeded: true,
    });
    expect(recorded?.ran_without_asking).toBe(true);
    const [stored] = await tdb.db
      .select({ confirmation_data: conversationToolCalls.confirmation_data })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, tool_call_id));
    expect(toolCallPolicyView(stored?.confirmation_data)).toMatchObject({
      ran_without_asking: true,
      rule: "user_instruction",
      because: { quote: "Schick bitte eine Mail an anna@firma.de" },
      bound_action: { recipients: ["anna@firma.de"] },
      rule_offer: null,
    });
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
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe("user_instruction");
    expect(entries[0]?.metadata).toMatchObject({
      tool: "call_connector",
      because: "Schick bitte eine Mail an anna@firma.de",
      recipients: ["anna@firma.de"],
      tool_call_id,
      verb: "send",
      effect_class: "ordinary",
      target: "POST /v1/messages/send",
      account: "mail",
      content_summary: "Verspätung — Ich komme später.",
    });
    const [request] = await tdb.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, conversation_id));
    const audited = (entries[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(audited.message_id).toBe(request?.id);
    const again = await resolvePersonCover(input(conversation_id));
    expect(again.instruction_covered).toBe(false);
    expect(again.record?.ask_reason).toBe("already_used");
  });

  test("a card that was shown records the bound action and no skipped confirmation", async () => {
    const conversation_id = await conversationWith([REQUEST]);
    const cover = await resolvePersonCover(
      input(conversation_id, { args: sendArgs("bob@firma.de") }),
    );
    const tool_call_id = await toolCall(conversation_id);
    const recorded = await recordPersonCover({
      db: tdb.db,
      tenant_id,
      conversation_id,
      tool_call_id,
      tool: "call_connector",
      actor_id: user_id,
      cover,
      resolved_rule: "computed_from_input",
      proceeded: false,
    });
    expect(recorded).toMatchObject({
      ran_without_asking: false,
      rule: null,
      because: null,
      ask_reason: "recipient_not_named",
      bound_action: { recipients: ["bob@firma.de"] },
    });
    const entries = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, conversation_id)));
    expect(entries).toEqual([]);
  });

  test("a covered plan that the policy still stopped is recorded as asked", async () => {
    const conversation_id = await conversationWith([REQUEST]);
    const cover = await resolvePersonCover(input(conversation_id));
    const tool_call_id = await toolCall(conversation_id);
    const recorded = await recordPersonCover({
      db: tdb.db,
      tenant_id,
      conversation_id,
      tool_call_id,
      tool: "call_connector",
      actor_id: user_id,
      cover,
      resolved_rule: "computed_from_input",
      proceeded: false,
    });
    expect(recorded).toMatchObject({ ran_without_asking: false, rule: null, because: null });
  });

  test("an answer to a question and a looked-up name ground the recipient", async () => {
    const conversation_id = await conversationWith([
      { text: "Kannst du Bob in Slack schreiben, dass das Meeting ausfällt?" },
    ]);
    await toolCall(conversation_id, {
      members: [
        { id: "U042", name: "bob" },
        { id: "U043", name: "carla" },
      ],
    });
    const slack = (channel: string) => ({
      connector_id: "slack",
      method: "POST",
      path: "/api/chat.postMessage",
      body: { channel, text: "Das Meeting fällt aus." },
    });
    const because = "Kannst du Bob in Slack schreiben";
    const right = await resolvePersonCover(
      input(conversation_id, { args: slack("U042"), because }),
    );
    expect(right.instruction_covered).toBe(true);
    const wrong = await resolvePersonCover(
      input(conversation_id, { args: slack("U043"), because }),
    );
    expect(wrong.record?.ask_reason).toBe("recipient_not_named");

    const asked = await conversationWith([{ text: "Schick Anna bitte die Zusammenfassung" }]);
    await tdb.db.insert(conversationElicitations).values({
      tenant_id,
      conversation_id: asked,
      tool_name: "ask_user_text",
      summary: "Adresse",
      input: { question: "An welche Adresse?" },
      output: { text: "anna.schmidt@firma.de" },
      status: "resolved",
      decided_by: user_id,
      decided_by_kind: "user",
      decided_at: new Date(getTestNow()),
    });
    const evidence = await loadCoverEvidence(tdb.db, tenant_id, asked);
    expect(evidence.segments.map((segment) => segment.kind)).toEqual(["message", "answer"]);
    expect(evidence.timezone).toBe("Europe/Berlin");
    const answered = await resolvePersonCover(
      input(asked, {
        args: {
          ...sendArgs("anna.schmidt@firma.de"),
          body: {
            to: "anna.schmidt@firma.de",
            subject: "Zusammenfassung",
            text: "Zusammenfassung",
          },
        },
        because: "Schick Anna bitte die Zusammenfassung",
      }),
    );
    expect(answered.instruction_covered).toBe(true);
  });

  test("a rule the person stored covers also when asking before writing, and never a task run", async () => {
    const conversation_id = await conversationWith([{ text: "Was steht heute an?" }]);
    const owner = { tenant_id, user_id };
    const action = describeBoundAction("call_connector", sendArgs("kunde@example.com"), [
      "kunde@example.com",
    ]);
    const args = sendArgs("kunde@example.com");
    const approved = contentHash(collectContent("call_connector", args));
    await noteApprovedAction(tdb.db, owner, action, approved);
    const offer = await noteApprovedAction(tdb.db, owner, action, approved);
    if (!offer) throw new Error("offer missing");
    const before = await resolvePersonCover(
      input(conversation_id, { args, because: null, ask_before_writing: true }),
    );
    expect(before.rule_covered).toBe(false);
    await decideRule(tdb.db, owner, offer.rule_id, "accept");
    for (const ask_before_writing of [false, true]) {
      const cover = await resolvePersonCover(
        input(conversation_id, { args, because: null, ask_before_writing }),
      );
      expect(cover.rule_covered).toBe(true);
      expect(cover.record).toMatchObject({
        ran_without_asking: true,
        rule: "standing_rule",
        rule_id: offer.rule_id,
        because: null,
      });
    }
    const unattended = await resolvePersonCover(
      input(conversation_id, { args, because: null, task_run: true }),
    );
    expect(unattended.rule_covered).toBe(false);
    const withKey = await resolvePersonCover(
      input(conversation_id, {
        args,
        because: null,
        principal: {
          ...principal,
          auth_source: { kind: "api_key", api_key_id: "k", credential_version: "1" },
        },
      }),
    );
    expect(withKey.rule_covered).toBe(false);
    expect(withKey.record?.ask_reason).toBe("no_browser_session");
  });

  test("a later confirmation transition keeps the bound action and the rule offer", async () => {
    const { recordTransition } = await import("../../confirmation.ts");
    const conversation_id = await conversationWith([REQUEST]);
    const cover = await resolvePersonCover(
      input(conversation_id, { args: sendArgs("bob@firma.de") }),
    );
    const tool_call_id = await toolCall(conversation_id);
    await recordTransition(tdb.db, {
      tool_call_id,
      tenant_id,
      to_state: "proposed",
      data: { resolved_mode: "confirm_before_execution" },
    });
    await recordPersonCover({
      db: tdb.db,
      tenant_id,
      conversation_id,
      tool_call_id,
      tool: "call_connector",
      actor_id: user_id,
      cover,
      resolved_rule: "computed_from_input",
      proceeded: false,
    });
    await recordTransition(tdb.db, {
      tool_call_id,
      tenant_id,
      to_state: "confirmed",
      data: { elicitation_id: "e-1" },
    });
    const [stored] = await tdb.db
      .select({ confirmation_data: conversationToolCalls.confirmation_data })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, tool_call_id));
    expect(stored?.confirmation_data).toMatchObject({ elicitation_id: "e-1" });
    expect(
      (stored?.confirmation_data as Record<string, unknown> | null)?.resolved_mode,
    ).toBeUndefined();
    expect(toolCallPolicyView(stored?.confirmation_data)).toMatchObject({
      ran_without_asking: false,
      ask_reason: "recipient_not_named",
      bound_action: { recipients: ["bob@firma.de"] },
    });
  });
});
