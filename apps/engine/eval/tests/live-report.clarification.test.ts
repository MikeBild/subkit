import { describe, expect, test } from "bun:test";
import {
  type ClarificationTargets,
  findReplyPlaceholders,
  LIVE_SCENARIOS,
  type LiveScenarioScore,
  type ObservedTurn,
  scenarioPassed,
  scoreScenario,
} from "../live-report.ts";
import {
  ASK_RECIPIENT_AND_SOURCE,
  CLARIFY_SPEC,
  call,
  NEGATIVE_SPEC,
  observation,
  turn,
} from "./live-report-fixtures.ts";

describe("scoreScenario · clarification", () => {
  const clarificationTargets = (score: LiveScenarioScore): ClarificationTargets =>
    score.targets as ClarificationTargets;

  test("happy path: one ask_user_text naming recipient and source, awaiting_input, nothing authored", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [call("list_connectors"), call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)],
          "awaiting_input",
          "Before I build this I need two details.",
        ),
      ]),
    );
    expect(score.kind).toBe("clarification");
    expect(clarificationTargets(score)).toEqual({
      single_clarifying_question: "PASS",
      no_authoring_before_answer: "PASS",
      question_names_missing_inputs: "PASS",
      no_placeholder_in_reply: "PASS",
      no_needless_question: "PASS",
    });
    expect(score.guard_fired).toBeNull();
    expect(score.previews).toBe(0);
    expect(score.llm_passes).toBeNull();
    expect(score.content_pass).toBe(true);
    expect(scenarioPassed(score)).toBe(true);
  });

  test("ask_user_form counts as the clarifying question; checks run over its fields", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("ask_user_form", {
              question: "Two details are missing",
              fields: [
                { name: "to", label: "Recipient e-mail address", type: "text", required: true },
                { name: "source", label: "Which data is the report built from?", type: "text" },
              ],
            }),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(score).single_clarifying_question).toBe("PASS");
    expect(clarificationTargets(score).question_names_missing_inputs).toBe("PASS");
    expect(scenarioPassed(score)).toBe(true);
  });

  test("two questions in the first turn fail single_clarifying_question", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("ask_user_text", { question: "Which e-mail address should receive it?" }),
            call("ask_user_text", { question: "Which data source is the report built from?" }),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(score).single_clarifying_question).toBe("FAIL");
    expect(clarificationTargets(score).question_names_missing_inputs).toBe("PASS");
    expect(scenarioPassed(score)).toBe(false);
  });

  test("authoring before the question fails no_authoring_before_answer", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("author_workflow", { goal: "emails the report" }, { ok: false }),
            call("ask_user_text", ASK_RECIPIENT_AND_SOURCE),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(score).no_authoring_before_answer).toBe("FAIL");
    expect(clarificationTargets(score).single_clarifying_question).toBe("PASS");
    expect(score.notes.join(" ")).toContain("author_workflow");
  });

  test("only an ask_user_confirm is not a clarifying question", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [call("ask_user_confirm", { question: "Shall I e-mail the report to the recipient?" })],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(score).single_clarifying_question).toBe("FAIL");
    expect(clarificationTargets(score).question_names_missing_inputs).toBe("FAIL");
  });

  test("a question that only asks for the recipient fails question_names_missing_inputs", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn([call("ask_user_text", { question: "Which e-mail address?" })], "awaiting_input"),
      ]),
    );
    expect(clarificationTargets(score).question_names_missing_inputs).toBe("FAIL");
    expect(score.notes.join(" ")).toContain("asks for the source");
    expect(score.content_pass).toBe(false);
  });

  test("a placeholder address in the reply text or the ask input fails no_placeholder_in_reply", () => {
    const inText = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)],
          "awaiting_input",
          "I will send it to user@example.com unless you tell me otherwise.",
        ),
      ]),
    );
    expect(clarificationTargets(inText).no_placeholder_in_reply).toBe("FAIL");
    expect(inText.notes.join(" ")).toContain("user@example.com");

    const inForm = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("ask_user_form", {
              question: "Recipient e-mail and data source?",
              fields: [
                { name: "to", label: "Recipient", type: "text", default: "user@example.com" },
              ],
            }),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(inForm).no_placeholder_in_reply).toBe("FAIL");
  });

  test("the placeholder attribute of ask_user_text and of a form field is scored like default", () => {
    const inTextPlaceholder = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("ask_user_text", {
              question: "Which address should receive the report, built from which data?",
              placeholder: "user@example.com",
            }),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(inTextPlaceholder).no_placeholder_in_reply).toBe("FAIL");
    expect(inTextPlaceholder.notes.join(" ")).toContain("user@example.com");

    const inFieldPlaceholder = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("ask_user_form", {
              question: "Recipient e-mail and data source?",
              fields: [
                { name: "to", label: "Recipient", type: "text", placeholder: "user@example.com" },
              ],
            }),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(inFieldPlaceholder).no_placeholder_in_reply).toBe("FAIL");

    const neutral = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("ask_user_text", {
              ...ASK_RECIPIENT_AND_SOURCE,
              placeholder: "name@company.tld",
            }),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(neutral).no_placeholder_in_reply).toBe("PASS");
  });

  test("no_placeholder_in_reply scores the question the user received, not the raw tool input the engine stripped", () => {
    const raw = {
      question: "Who receives the report and what should the report contain?",
      fields: [
        { name: "to", label: "Recipient e-mail", type: "text", placeholder: "you@example.com" },
        { name: "content", label: "What should the report contain?", type: "text" },
      ],
    };
    const delivered = {
      question: raw.question,
      fields: [
        { name: "to", label: "Recipient e-mail", type: "text" },
        { name: "content", label: "What should the report contain?", type: "text" },
      ],
    };
    const strippedTurn: ObservedTurn = {
      ...turn([call("ask_user_form", raw)], "awaiting_input"),
      delivered_ask: { tool_name: "ask_user_form", input: delivered },
    };
    const score = scoreScenario(CLARIFY_SPEC, observation(CLARIFY_SPEC, [strippedTurn]));
    expect(clarificationTargets(score).no_placeholder_in_reply).toBe("PASS");

    const leakedTurn: ObservedTurn = {
      ...turn([call("ask_user_form", raw)], "awaiting_input"),
      delivered_ask: { tool_name: "ask_user_form", input: raw },
    };
    const leaked = scoreScenario(CLARIFY_SPEC, observation(CLARIFY_SPEC, [leakedTurn]));
    expect(clarificationTargets(leaked).no_placeholder_in_reply).toBe("FAIL");
  });

  test("a question about what the report should contain names the missing source", () => {
    const spec = LIVE_SCENARIOS.find((s) => s.slug === "underspecified-asks-first");
    const sourceCheck = spec?.content_checks.find((c) => c.name === "asks for the source");
    expect(sourceCheck).toBeDefined();
    expect(
      new RegExp(sourceCheck!.pattern, sourceCheck!.flags).test("What should the report contain?"),
    ).toBe(true);
  });

  test("a real address in the reply is not a placeholder", () => {
    expect(
      findReplyPlaceholders(
        turn(
          [call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)],
          "awaiting_input",
          "Should it go to ops@acme-reports.io like last time?",
        ),
      ),
    ).toEqual([]);
  });

  test("five tool calls in the first turn exceed the clarification budget", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [
            call("list_connectors"),
            call("find_connector"),
            call("list_workflows"),
            call("search_knowledge"),
            call("ask_user_text", ASK_RECIPIENT_AND_SOURCE),
          ],
          "awaiting_input",
        ),
      ]),
    );
    expect(clarificationTargets(score).single_clarifying_question).toBe("FAIL");
    expect(score.notes.join(" ")).toContain("5 tool calls");
  });

  test("a first turn that ends active instead of awaiting_input fails single_clarifying_question", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn([call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)], "active", "", null),
      ]),
    );
    expect(clarificationTargets(score).single_clarifying_question).toBe("FAIL");
  });

  test("no turns at all: the question targets fail and the scenario fails without crashing", () => {
    const score = scoreScenario(CLARIFY_SPEC, {
      ...observation(CLARIFY_SPEC, []),
      status: "error",
      error: "connect ECONNREFUSED",
    });
    expect(clarificationTargets(score)).toMatchObject({
      single_clarifying_question: "FAIL",
      question_names_missing_inputs: "FAIL",
    });
    expect(score.content_pass).toBe(false);
    expect(scenarioPassed(score)).toBe(false);
    expect(score.notes.join(" ")).toContain("ECONNREFUSED");
  });
});

describe("clarification · a prose question answered through the composer counts", () => {
  test("one prose question naming recipient and source, no tool, passes", () => {
    const score = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [],
          "active",
          "Who should receive the report by e-mail, and which data source should it come from?",
        ),
      ]),
    );
    expect(score.targets).toMatchObject({
      single_clarifying_question: "PASS",
      question_names_missing_inputs: "PASS",
      no_authoring_before_answer: "PASS",
    });
    expect(score.notes.join(" ")).toContain("asked in prose");
  });

  test("a prose question after authoring, or a statement without a question, fails", () => {
    const authored = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [
        turn(
          [call("author_workflow")],
          "active",
          "Who should receive the report and from which source?",
        ),
      ]),
    );
    expect(authored.targets).toMatchObject({
      single_clarifying_question: "FAIL",
      no_authoring_before_answer: "FAIL",
    });
    const statement = scoreScenario(
      CLARIFY_SPEC,
      observation(CLARIFY_SPEC, [turn([], "active", "I will build the e-mail report now.")]),
    );
    expect(statement.targets).toMatchObject({ single_clarifying_question: "FAIL" });
  });
});

describe("clarification · scorer reads real questions the PROD model asked", () => {
  test("'What report should this workflow email?' asks for the source", () => {
    const spec = LIVE_SCENARIOS.find((s) => s.slug === "underspecified-placeholder-rejected");
    const sourceCheck = spec?.content_checks.find((c) => c.name.includes("source"));
    expect(sourceCheck).toBeDefined();
    expect(
      new RegExp(sourceCheck!.pattern, sourceCheck!.flags).test(
        "What report should this workflow email? (e.g. daily sales report)",
      ),
    ).toBe(true);
  });
});

describe("clarification · a gated build that names the refused placeholder is the renewed ask", () => {
  test("the model asks for real values in a statement after the gate fired", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [
        turn([call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)], "awaiting_input"),
        turn(
          [
            call(
              "author_workflow",
              {},
              {
                ok: false,
                error_code: "workflow_placeholder_destination",
                placeholder_destinations: [{ path: "steps.send.url", match: "test@example.com" }],
              },
            ),
          ],
          "active",
          "The engine needs real values. You provided test@example.com, which cannot be delivered. Please send the real recipient address.",
        ),
      ]),
    );
    const targets = score.targets as ClarificationTargets;
    expect(score.guard_fired).toBe(true);
    expect(targets.placeholder_rejected_after_answer).toBe("PASS");
  });
});
