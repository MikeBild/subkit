import { describe, expect, test } from "bun:test";
import { provenScenarios } from "../live-authoring.ts";
import {
  askedQuestions,
  type ClarificationTargets,
  LIVE_SCENARIOS,
  type LiveScenarioScore,
  type LiveScenarioSpec,
  needlessQuestions,
  scenarioPassed,
  scoreScenario,
} from "../live-report.ts";
import {
  ASK_RECIPIENT_AND_SOURCE,
  CLARIFY_SPEC,
  call,
  observation,
  turn,
} from "./live-report-fixtures.ts";

const SPEC: LiveScenarioSpec = {
  slug: "weather",
  kind: "authoring",
  goal: "Return tomorrow's weather for Berlin in degrees Celsius. Preview it and save it.",
  connectors: ["open-meteo"],
  content_checks: [{ name: "digits", pattern: "\\d" }],
  facts: [
    { name: "location", pattern: "which city|latitude", flags: "i" },
    { name: "save", pattern: "\\bsave\\b|save_workflow_draft", flags: "i" },
  ],
};

const OFF = { ask_before_writing: false };
const ON = { ask_before_writing: true };

describe("askedQuestions", () => {
  test("collects structured asks, confirmations, approvals and prose questions", () => {
    const turns = [
      turn([call("ask_user_text", { question: "Which city?" })], "awaiting_input"),
      turn([call("ask_user_confirm", { question: "Save it now?" })], "awaiting_input"),
      {
        ...turn([], "awaiting_input"),
        delivered_ask: { tool_name: "save_workflow_draft", input: { slug: "w" } },
      },
      turn([], "active", "The preview looks right. Should I also schedule it? Done."),
    ];
    expect(askedQuestions(turns)).toEqual([
      { kind: "question", text: "Which city?" },
      { kind: "confirmation", text: '{"question":"Save it now?"}' },
      { kind: "approval", text: 'save_workflow_draft {"slug":"w"}' },
      { kind: "question", text: "Should I also schedule it?" },
    ]);
  });

  test("a statement that mentions a fact is not a question", () => {
    expect(askedQuestions([turn([], "active", "I used Berlin's latitude. Saved.")])).toEqual([]);
  });
});

describe("needlessQuestions", () => {
  test("a question the request already answers is needless", () => {
    const turns = [
      turn([call("ask_user_text", { question: "Which city do you mean?" })], "awaiting_input"),
    ];
    expect(needlessQuestions(SPEC, turns, OFF)).toEqual([
      { kind: "question", text: "Which city do you mean?", fact: "location" },
    ]);
  });

  test("a question about something the request leaves open is fine", () => {
    const turns = [
      turn([call("ask_user_text", { question: "Morning or evening?" })], "awaiting_input"),
    ];
    expect(needlessQuestions(SPEC, turns, OFF)).toEqual([]);
  });

  test("asking before a save the request already asked for is needless", () => {
    const turns = [
      {
        ...turn([], "awaiting_input"),
        delivered_ask: { tool_name: "save_workflow_draft", input: {} },
      },
    ];
    expect(needlessQuestions(SPEC, turns, OFF).map((q) => q.fact)).toEqual(["save"]);
  });

  test("with “Always ask first” a write confirmation or approval is required, never needless", () => {
    const turns = [
      turn([call("ask_user_confirm", { question: "Save the workflow?" })], "awaiting_input"),
      {
        ...turn([], "awaiting_input"),
        delivered_ask: { tool_name: "save_workflow_draft", input: {} },
      },
    ];
    expect(needlessQuestions(SPEC, turns, ON)).toEqual([]);
  });

  test("“Always ask first” still counts an open question the request answered", () => {
    const turns = [turn([call("ask_user_text", { question: "Which city?" })], "awaiting_input")];
    expect(needlessQuestions(SPEC, turns, ON).map((q) => q.fact)).toEqual(["location"]);
  });

  test("a case without facts never has a needless question", () => {
    const turns = [turn([call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)], "awaiting_input")];
    expect(needlessQuestions(CLARIFY_SPEC, turns, OFF)).toEqual([]);
  });
});

describe("scoreScenario · no_needless_question", () => {
  test("a needless question fails an authoring case", () => {
    const obs = observation(SPEC, [
      turn([call("ask_user_text", { question: "Which city?" })], "awaiting_input"),
    ]);
    const score = scoreScenario(SPEC, obs);
    expect(score.targets).toMatchObject({ no_needless_question: "FAIL" });
    expect(scenarioPassed(score)).toBe(false);
    expect(score.notes).toContain("needless question about location: Which city?");
  });

  test("the required clarifying question of an underspecified case passes", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn([call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)], "awaiting_input"),
      ]),
    );
    expect((score.targets as ClarificationTargets).no_needless_question).toBe("PASS");
  });

  test("the built-in clarification cases carry no facts, so their questions stay required", () => {
    const clarifying = LIVE_SCENARIOS.filter((s) => s.kind === "clarification");
    expect(clarifying.length).toBeGreaterThan(0);
    for (const spec of clarifying) expect(spec.facts ?? []).toEqual([]);
    for (const spec of LIVE_SCENARIOS.filter((s) => s.kind === "authoring")) {
      expect(spec.facts?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("provenScenarios", () => {
  const score = (scenario: string, pass: boolean): LiveScenarioScore =>
    ({
      scenario,
      content_pass: pass,
      targets: { no_needless_question: pass ? "PASS" : "FAIL" },
    }) as unknown as LiveScenarioScore;

  test("a scenario is proven only when every scored trial passed and no trial hit a provider fault", () => {
    const proven = provenScenarios(
      [score("a", true), score("a", true), score("b", true), score("b", false), score("c", true)],
      [{ scenario: "c", trial: 2, fault: "timeout", error: "timed out" }],
    );
    expect([...proven]).toEqual(["a"]);
  });
});
