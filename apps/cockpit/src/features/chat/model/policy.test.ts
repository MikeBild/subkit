import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ruleDates, splitRules } from "@/features/rules";
import { type PluralKey, type TranslationKey, translate, translatePlural } from "@/lib/i18n";
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
  rawRequest,
  ruleName,
  scopeSentence,
  type ToolCallPolicy,
  targetLabel,
} from "./policy";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);
const deN = (key: PluralKey, count: number, values?: Record<string, string | number>) =>
  translatePlural("de", key, count, values);
const enN = (key: PluralKey, count: number, values?: Record<string, string | number>) =>
  translatePlural("en", key, count, values);

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
    resolve(import.meta.dir, "../../../../../engine/src/conversations", file),
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
    expect(actionFacts(action, de, deN).map((fact) => [fact.label, fact.value])).toEqual([
      ["Aktion", "Senden"],
      ["Ziel", "anna@firma.de"],
      ["Konto", "Gmail"],
      ["Inhalt", "Betreff: Wochenzahlen"],
    ]);
    expect(
      actionFacts({ ...action, recipients: [] }, de, deN).find((fact) => fact.id === "target")
        ?.value,
    ).toBe("Messages");
    const team = { ...action, recipients: ["anna@firma.de", "bob@firma.de"] };
    expect(actionFacts(team, de, deN).find((fact) => fact.id === "target")?.value).toBe(
      "anna@firma.de, bob@firma.de (2 Personen)",
    );
    expect(actionFacts(team, en, enN).find((fact) => fact.id === "target")?.value).toBe(
      "anna@firma.de, bob@firma.de (2 people)",
    );
    expect(actionFacts({ ...action, effect_class: "payment" }, de, deN)[0]?.value).toBe(
      "Senden · Zahlung",
    );
    expect(
      actionFacts({ verb: "run", target: null, account: null, recipients: [] }, en, enN).map(
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
        policy: { ...policy, ran_without_asking: false, ask_reason: "ask_before_writing" },
      }),
    ).toMatchObject({
      askReason: "ask_before_writing",
      because: "Schick bitte eine Mail an anna@firma.de",
    });
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
    expect(actionFacts(drafted, de, deN).map((fact) => fact.id)).not.toContain("content");
    expect(fullContent({ ...action, content: null })).toBeNull();
    expect(fullContent({ content: "   " })).toBeNull();
  });

  test("a text the engine cut at its limit is named as cut", () => {
    const cut = `${"a".repeat(FULL_CONTENT_CAP - 1)}…`;
    expect(fullContent({ content: cut })?.capped).toBe(true);
    expect(fullContent({ content: "Kurz und mit Auslassung …" })?.capped).toBe(false);
    const engine = readFileSync(
      resolve(
        import.meta.dir,
        "../../../../../engine/src/conversations/instruction-cover/content.ts",
      ),
      "utf8",
    );
    expect(engine).toContain(`MAX_FULL_CONTENT_CHARS = ${FULL_CONTENT_CAP};`);
  });

  test("an action that ran without asking says what ran and why", () => {
    const ran = ranWithoutAsking(policy);
    expect(ran && ranLine(ran, de)).toBe(
      "Senden: Messages an anna@firma.de, weil du es verlangt hast",
    );
    expect(ran?.quote).toBe("Schick bitte eine Mail an anna@firma.de");
    const byRule = ranWithoutAsking({ ...policy, rule: "standing_rule", because: null });
    expect(byRule && ranLine(byRule, en)).toBe("Send: Messages to anna@firma.de, per your rule");
    expect(byRule?.quote).toBeNull();
    const ruleWithWords = {
      ...policy,
      rule: "standing_rule" as const,
      because: null,
      rule_quote: " always mail anna@firma.de ",
    };
    expect(ranWithoutAsking(ruleWithWords)?.quote).toBe("always mail anna@firma.de");
    expect(ranWithoutAsking({ ...policy, ran_without_asking: false })).toBeNull();
    expect(ranWithoutAsking(null)).toBeNull();
    expect(actionLine({ verb: "save", target: null, account: null, recipients: [] }, de)).toBe(
      "Speichern",
    );
  });

  test("a rule is named by its verb and readable target and shows its whole scope", () => {
    expect(ruleName(action, de)).toBe("Senden: Messages");
    expect(scopeSentence(action, de)).toBe("Senden: Messages über Gmail an anna@firma.de");
    expect(
      scopeSentence({ verb: "create", target: "POST /echo", account: null, recipients: [] }, en),
    ).toBe("Create: Echo without a recipient");
    expect(ruleName({ ...action, target: "Kalender Team" }, de)).toBe("Senden: Kalender Team");
    expect(ruleName({ ...action, target: "POST /v1/" }, de)).toBe("Senden");
  });

  test("a raw request target reads as its resource and stays available as the request", () => {
    expect(targetLabel("POST /v1/messages/send")).toBe("Messages");
    expect(targetLabel("PATCH https://api.example/v1/reports/42")).toBe("Reports");
    expect(
      targetLabel("GET /repos/{owner}/{repo}/pull_requests/0f8fad5b-d9cb-469f-a165-70867728950e"),
    ).toBe("Pull requests");
    expect(targetLabel("DELETE /v2/calendar-events/123?force=true")).toBe("Calendar events");
    expect(targetLabel("Team-Kalender")).toBe("Team-Kalender");
    expect(targetLabel(null)).toBeNull();
    expect(rawRequest("POST /v1/messages/send")).toBe("POST /v1/messages/send");
    expect(rawRequest("https://api.example/v1/reports")).toBe("https://api.example/v1/reports");
    expect(rawRequest("Team-Kalender")).toBeNull();
    expect(rawRequest(null)).toBeNull();
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
    source_quote: null,
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
