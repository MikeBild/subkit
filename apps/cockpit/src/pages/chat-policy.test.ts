import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type TranslationKey, translate } from "@/lib/i18n";
import { newChatMode, personalModeSuffixKey } from "./chat-default-mode";
import {
  ASK_REASON_KEYS,
  actionFacts,
  actionLine,
  approvalBinding,
  askReasonKey,
  FULL_CONTENT_CAP,
  fullContent,
  livePolicy,
  ranLine,
  ranWithoutAsking,
  refusedApprovalReply,
  ruleName,
  scopeSentence,
  type ToolCallPolicy,
  typedDecision,
} from "./chat-policy";
import { ruleDates, splitRules } from "./settings-rules-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const action = {
  verb: "send" as const,
  effect_class: "ordinary" as const,
  target: "POST /v1/messages/send",
  account: "Gmail",
  recipients: ["anna@firma.de"],
  content_summary: "Betreff: Wochenzahlen",
};

const policy: ToolCallPolicy = {
  ran_without_asking: true,
  rule: "user_instruction",
  bound_action: action,
  because: { quote: "Schick bitte eine Mail an anna@firma.de", message_id: "m1" },
  rule_id: null,
  ask_reason: null,
  rule_offer: null,
};

function unionMembers(file: string, name: string): string[] {
  const source = readFileSync(
    resolve(import.meta.dir, "../../../engine/src/conversations", file),
    "utf8",
  );
  const body = source.slice(source.indexOf(`export type ${name} =`)).split(";")[0] ?? "";
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
}

describe("why an action asked", () => {
  test("every reason the engine can give has a sentence of its own in both languages", () => {
    const reasons = [
      ...unionMembers("instruction-cover/decide.ts", "CoverRefusal"),
      ...unionMembers("instruction-cover/grounding.ts", "GroundingReason"),
      ...unionMembers("approval-rules/scope.ts", "RuleRefusal"),
      ...unionMembers("instruction-cover/gate.ts", "AskReason"),
    ];
    expect(reasons).toContain("rule_expired");
    expect(reasons).toContain("no_browser_session");
    expect(reasons).toContain("content_not_given");
    expect(reasons.length).toBeGreaterThan(20);
    for (const reason of reasons) {
      const key = ASK_REASON_KEYS[reason];
      expect(key, `${reason} has no sentence`).toBeDefined();
      if (!key) continue;
      expect(de(key)).not.toBe(key);
      expect(en(key)).not.toBe(key);
    }
  });

  test("a reason from a newer engine still reads as a sentence, and no reason reads as nothing", () => {
    expect(askReasonKey("something_new")).toBe("chat.policy.ask.unclear");
    expect(askReasonKey(null)).toBeNull();
    expect(de("chat.policy.ask.recipient")).toBe("Du hast diesen Empfänger nicht genannt.");
  });
});

describe("the bound action", () => {
  test("the card names verb, target, account, recipients and content", () => {
    expect(actionFacts(action, de).map((fact) => [fact.label, fact.value])).toEqual([
      ["Aktion", "Senden"],
      ["Ziel", "POST /v1/messages/send"],
      ["Konto", "Gmail"],
      ["Empfänger", "anna@firma.de"],
      ["Inhalt", "Betreff: Wochenzahlen"],
    ]);
    expect(actionFacts({ ...action, effect_class: "payment" }, de)[0]?.value).toBe(
      "Senden · Zahlung",
    );
    expect(
      actionFacts({ verb: "run", target: null, account: null, recipients: [] }, en).map(
        (fact) => fact.id,
      ),
    ).toEqual(["verb"]);
  });

  test("the card reads its binding from the asked call, whichever side carries it", () => {
    expect(
      approvalBinding({ input: { bound_action: action, ask_reason: "recipient_not_named" } }),
    ).toEqual({
      action,
      askReason: "recipient_not_named",
      askDetail: null,
      because: null,
    });
    expect(
      approvalBinding({
        input: {},
        policy: { ...policy, ran_without_asking: false, ask_reason: "mode" },
      }),
    ).toMatchObject({ askReason: "mode", because: "Schick bitte eine Mail an anna@firma.de" });
    expect(approvalBinding({ input: { question: "Sure?" } })).toBeNull();
    expect(approvalBinding({ input: null })).toBeNull();
  });

  test("the drafted text and what exactly was missing travel with the binding", () => {
    const drafted = { ...action, content: "Hallo Anna,\n\nanbei die Zahlen.\n\nViele Grüße" };
    const bound = approvalBinding({
      input: { bound_action: drafted },
      policy: {
        ...policy,
        ran_without_asking: false,
        because: null,
        bound_action: drafted,
        ask_reason: "content_not_given",
        ask_detail: "adds the address bob@firma.de",
      },
    });
    expect(bound?.askDetail).toBe("adds the address bob@firma.de");
    expect(bound?.action.content).toBe(drafted.content);
    expect(fullContent(drafted)).toEqual({ text: drafted.content, capped: false, long: false });
    expect(fullContent({ content: "Zeile\n".repeat(12) })?.long).toBe(true);
    expect(fullContent({ content: "a".repeat(601) })?.long).toBe(true);
    expect(actionFacts(drafted, de).map((fact) => fact.id)).not.toContain("content");
    expect(fullContent({ ...action, content: null })).toBeNull();
    expect(fullContent({ content: "   " })).toBeNull();
  });

  test("a text the engine cut at its limit is named as cut", () => {
    const cut = `${"a".repeat(FULL_CONTENT_CAP - 1)}…`;
    expect(fullContent({ content: cut })?.capped).toBe(true);
    expect(fullContent({ content: "Kurz und mit Auslassung …" })?.capped).toBe(false);
    const engine = readFileSync(
      resolve(import.meta.dir, "../../../engine/src/conversations/instruction-cover/content.ts"),
      "utf8",
    );
    expect(engine).toContain(`MAX_FULL_CONTENT_CHARS = ${FULL_CONTENT_CAP};`);
  });

  test("an action that ran without asking says what ran and why", () => {
    const ran = ranWithoutAsking(policy);
    expect(ran && ranLine(ran, de)).toBe(
      "Senden: POST /v1/messages/send an anna@firma.de, weil du es verlangt hast",
    );
    expect(ran?.quote).toBe("Schick bitte eine Mail an anna@firma.de");
    const byRule = ranWithoutAsking({ ...policy, rule: "standing_rule", because: null });
    expect(byRule && ranLine(byRule, en)).toBe(
      "Send: POST /v1/messages/send to anna@firma.de, per your rule",
    );
    expect(ranWithoutAsking({ ...policy, ran_without_asking: false })).toBeNull();
    expect(ranWithoutAsking(null)).toBeNull();
    expect(actionLine({ verb: "save", target: null, account: null, recipients: [] }, de)).toBe(
      "Speichern",
    );
  });

  test("a rule is named by its verb and target and shows its whole scope", () => {
    expect(ruleName(action, de)).toBe("Senden: POST /v1/messages/send");
    expect(scopeSentence(action, de)).toBe(
      "Senden: POST /v1/messages/send über Gmail an anna@firma.de",
    );
    expect(
      scopeSentence({ verb: "create", target: "POST /echo", account: null, recipients: [] }, en),
    ).toBe("Create: POST /echo without a recipient");
  });
});

describe("a reply while a card is open", () => {
  test("only a refused reply to an approval card offers to decline and rephrase", () => {
    const blocked = (tool_name: string) => ({
      code: "pending_elicitation_blocked",
      details: { pending_elicitation: { id: "e1", tool_name } },
    });
    expect(refusedApprovalReply(blocked("ask_user_confirm"))).toBe("e1");
    expect(refusedApprovalReply(blocked("ask_user_text"))).toBeNull();
    expect(refusedApprovalReply({ code: "provider_timeout", details: null })).toBeNull();
    expect(de("chat.policy.declineAndRephrase")).toBe("Ablehnen und neu formulieren");
  });
});

describe("a typed yes or no while an approval card is open", () => {
  test("is recognised as what was meant and never as a decision", () => {
    for (const text of ["ja", "Ja!", " OK ", "yes.", "Einmal erlauben", "mach das"])
      expect(typedDecision(text)).toBe("approve");
    for (const text of ["nein", "Nein.", "no", "nö", "Ablehnen", "lieber nicht"])
      expect(typedDecision(text)).toBe("decline");
    for (const text of ["", null, "ja, aber an eine andere Adresse", "jein", "sende an Anna"])
      expect(typedDecision(text)).toBeNull();
    expect(de("chat.policy.meant", { choice: de("chat.approval.approve") })).toBe(
      "Meintest du: Einmal erlauben?",
    );
    expect(de("chat.policy.meant", { choice: de("chat.approval.decline") })).toBe(
      "Meintest du: Ablehnen?",
    );
  });
});

describe("an action that ran without asking", () => {
  test("is read from the live stream part by its call", () => {
    const policy = { ran_without_asking: true, rule: "standing_rule" };
    expect(
      livePolicy({
        type: "data_part",
        data_type: "ran_without_asking",
        payload: { call_id: "c1", tool: "send_mail", policy },
      }),
    ).toEqual({ callId: "c1", policy: policy as never });
    expect(livePolicy({ type: "data_part", data_type: "playbook", payload: {} })).toBeNull();
    expect(livePolicy({ type: "data_part", data_type: "ran_without_asking" })).toBeNull();
    expect(livePolicy({ type: "tool_result", payload: { call_id: "c1", policy } })).toBeNull();
  });
});

describe("the mode a new conversation starts in", () => {
  test("the person's default applies until they pick another mode", () => {
    expect(newChatMode(null, "ask")).toBe("ask");
    expect(newChatMode("plan", "ask")).toBe("plan");
    expect(newChatMode(null, undefined)).toBe("auto");
  });

  test("the list marks the person's own default, or the system default while none is chosen", () => {
    const chosen = { default_chat_mode: "ask" as const, unset: [] };
    expect(personalModeSuffixKey("ask", chosen)).toBe("chat.mode.yourDefault");
    expect(personalModeSuffixKey("auto", chosen)).toBeNull();
    const unset = { default_chat_mode: "auto" as const, unset: ["default_chat_mode"] };
    expect(personalModeSuffixKey("auto", unset)).toBe("chat.mode.systemDefault");
    expect(personalModeSuffixKey("auto", undefined)).toBe("chat.mode.systemDefault");
  });
});

describe("the rules list", () => {
  const rule = {
    id: "r1",
    state: "active" as const,
    tool: "call_connector",
    verb: "send",
    target: "POST /echo",
    account: null,
    connector: null,
    operation: "POST /echo",
    content_class: "same_content" as const,
    expires_at: "2027-01-31T10:00:00.000Z",
    expired: false,
    daily_limit: 20,
    uses_today: 0,
    recipients: [],
    approvals_count: 2,
    use_count: 0,
    offered_at: "2026-11-01T10:00:00.000Z",
    decided_at: "2026-11-02T10:00:00.000Z",
    revoked_at: null,
    last_used_at: null,
    created_at: "2026-10-30T10:00:00.000Z",
  };

  test("active and offered rules are told apart, newest first", () => {
    const older = { ...rule, id: "r0", decided_at: "2026-10-31T10:00:00.000Z" };
    const offered = { ...rule, id: "r2", state: "offered" as const, decided_at: null };
    const split = splitRules([
      older,
      offered,
      rule,
      { ...rule, id: "r3", state: "revoked" as const },
    ]);
    expect(split.active.map((entry) => entry.id)).toEqual(["r1", "r0"]);
    expect(split.offered.map((entry) => entry.id)).toEqual(["r2"]);
  });

  test("an active rule dates from the person's decision, an offer from when it was offered", () => {
    expect(ruleDates(rule).created).toBe("2026-11-02T10:00:00.000Z");
    expect(ruleDates({ ...rule, state: "offered", decided_at: null }).created).toBe(
      "2026-11-01T10:00:00.000Z",
    );
    expect(ruleDates(rule).lastUsed).toBeNull();
  });
});
