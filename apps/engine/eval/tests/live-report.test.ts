import { describe, expect, test } from "bun:test";
import {
  aggregateTrials,
  BENCHMARK_TARGETS,
  bindScenarioInputs,
  buildLiveReport,
  type ClarificationTargets,
  evaluateBenchmarkTargets,
  extractJudgeVerdict,
  extractLlmPasses,
  extractPreviews,
  findReplyPlaceholders,
  LIVE_SCENARIOS,
  type LiveScenarioScore,
  type LiveScenarioSpec,
  type ObservedToolCall,
  type ObservedTurn,
  previewWasAutoRepaired,
  runContentChecks,
  type ScenarioObservation,
  scenarioPassed,
  scoreScenario,
  specNeedsRecipient,
} from "../live-report.ts";

const SPEC: LiveScenarioSpec = {
  slug: "droplet-specs-email",
  kind: "authoring",
  goal: "Email ops@acme.test the droplet specs.",
  connectors: ["digitalocean", "gmail"],
  content_checks: [
    { name: "recipient", pattern: "ops@acme\\.test" },
    { name: "specs", pattern: "vcpu", flags: "i" },
  ],
};

const CLARIFY_SPEC: LiveScenarioSpec = {
  slug: "underspecified-asks-first",
  kind: "clarification",
  goal: "Author a workflow that emails the report. Preview it and save it.",
  connectors: [],
  content_checks: [
    {
      name: "asks for the recipient",
      pattern: "recipient|address|e-?mail|to whom|empf",
      flags: "i",
    },
    {
      name: "asks for the source",
      pattern: "source|data|which report|from|quelle|woher",
      flags: "i",
    },
  ],
};

const NEGATIVE_SPEC: LiveScenarioSpec = {
  ...CLARIFY_SPEC,
  slug: "underspecified-placeholder-rejected",
  answer_turns: [
    "Send it to test@example.com by a plain HTTP POST to https://hooks.example.com/report with a JSON body {to, subject, rows}. The data is the first 5 posts from https://jsonplaceholder.typicode.com/posts (id and title). Subject: Post report. No schedule, I run it on demand. That is everything, build and preview it now.",
  ],
};

let callSeq = 0;
function call(tool: string, input: unknown = {}, output: unknown = { ok: true }): ObservedToolCall {
  callSeq += 1;
  return { tool, input, output, call_id: `call_${callSeq}` };
}

function turn(
  tool_calls: ObservedToolCall[],
  status: string,
  assistant_text = "",
  pending_elicitation_id: string | null = status === "awaiting_input" ? "elic_1" : null,
): ObservedTurn {
  return { tool_calls, assistant_text, status, pending_elicitation_id };
}

function observation(
  spec: LiveScenarioSpec,
  turns: ObservedTurn[],
  extra: Partial<ScenarioObservation> = {},
): ScenarioObservation {
  const results = turns.flatMap((t) => t.tool_calls);
  return {
    scenario: spec.slug,
    tool_calls: results.length,
    results,
    turns,
    committed_workflow_id: null,
    created_artifacts: [{ kind: "conversation", id: "conv_1" }],
    status: turns[turns.length - 1]?.status ?? "unknown",
    wall_ms: 1,
    ...extra,
  };
}

const ASK_RECIPIENT_AND_SOURCE = {
  question:
    "Who should receive the report (e-mail address), and which data is the report built from?",
};

function happyObservation(): ScenarioObservation {
  return observation(SPEC, [
    turn(
      [
        call("author_workflow", { goal: "x" }, { attempts: 1, next: "dry_run_workflow" }),
        call(
          "dry_run_workflow",
          {},
          {
            judge: { verdict: "passes", reason: "ok", missing: [] },
            step_trace: [
              {
                step_id: "send",
                held: true,
                held_request: {
                  body: { to: "ops@acme.test", html: "<p>web — 2 vCPU / 4GB / 80GB</p>" },
                },
              },
            ],
          },
        ),
        call("save_workflow_draft", {}, { ok: true, data: { workflow_id: "wf_1" } }),
        call("list_connectors"),
      ],
      "committed",
    ),
  ]);
}

describe("extraction helpers", () => {
  test("extractLlmPasses reads attempts off the author_workflow envelope (bare or {ok,data}-wrapped)", () => {
    expect(extractLlmPasses([call("author_workflow", {}, { attempts: 2 })])).toBe(2);
    expect(
      extractLlmPasses([call("author_workflow", {}, { ok: true, data: { attempts: 1 } })]),
    ).toBe(1);
    expect(extractLlmPasses([call("dry_run_workflow", {}, { attempts: 9 })])).toBeNull();
  });

  test("extractPreviews keeps dry_run_workflow envelopes in call order", () => {
    const previews = extractPreviews([
      call("dry_run_workflow", {}, { judge: { verdict: "failed" } }),
      call("list_connectors"),
      call("dry_run_workflow", {}, { judge: { verdict: "passes" } }),
    ]);
    expect(previews).toHaveLength(2);
    expect(extractJudgeVerdict(previews[0])).toBe("failed");
    expect(extractJudgeVerdict(previews[1])).toBe("passes");
  });

  test("runContentChecks reports each failed check by name", () => {
    const { pass, failed } = runContentChecks("hello world", [
      { name: "has hello", pattern: "hello" },
      { name: "has specs", pattern: "vcpu", flags: "i" },
    ]);
    expect(pass).toBe(false);
    expect(failed).toEqual(["has specs"]);
  });

  test("previewWasAutoRepaired reads the preview.auto_repaired warning or the auto_repair block", () => {
    expect(
      previewWasAutoRepaired({
        warnings: [{ step_key: "$output", code: "preview.auto_repaired", message: "m" }],
      }),
    ).toBe(true);
    expect(previewWasAutoRepaired({ auto_repair: { site: "output_transform", attempts: 1 } })).toBe(
      true,
    );
    expect(previewWasAutoRepaired({ warnings: [{ code: "scope.drift" }] })).toBe(false);
    expect(previewWasAutoRepaired(undefined)).toBe(false);
  });
});

describe("bindScenarioInputs", () => {
  const TEMPLATE: LiveScenarioSpec = {
    slug: "t",
    kind: "authoring",
    goal: "Email {recipient} the report.",
    answer_turns: ["Send it to {recipient}."],
    connectors: [],
    content_checks: [{ name: "recipient present", pattern: "{recipient}" }],
  };

  test("replaces {recipient} in goal and answer turns verbatim, in patterns regex-escaped", () => {
    const bound = bindScenarioInputs(TEMPLATE, { recipient: "ops+eval@acme.test" });
    expect(bound.goal).toBe("Email ops+eval@acme.test the report.");
    expect(bound.answer_turns).toEqual(["Send it to ops+eval@acme.test."]);
    expect(bound.content_checks[0]?.pattern).toBe("ops\\+eval@acme\\.test");
    expect(new RegExp(bound.content_checks[0]?.pattern ?? "").test("to ops+eval@acme.test")).toBe(
      true,
    );
    expect(new RegExp(bound.content_checks[0]?.pattern ?? "").test("opsXeval@acmeXtest")).toBe(
      false,
    );
  });

  test("leaves the source spec untouched and reports which specs need a recipient", () => {
    bindScenarioInputs(TEMPLATE, { recipient: "a@b.test" });
    expect(TEMPLATE.goal).toContain("{recipient}");
    expect(specNeedsRecipient(TEMPLATE)).toBe(true);
    expect(specNeedsRecipient(CLARIFY_SPEC)).toBe(false);
  });
});

describe("benchmark targets (authoring)", () => {
  const base = {
    llm_passes: 1,
    previews: 1,
    tool_calls: 10,
    first_preview_content_pass: true,
  };

  test("all targets PASS on the happy shape", () => {
    expect(Object.values(evaluateBenchmarkTargets(base))).toEqual(["PASS", "PASS", "PASS", "PASS"]);
  });

  test("pipeline_llm_calls_le_3 boundary: 3 passes, 4 fails, missing fails", () => {
    expect(
      evaluateBenchmarkTargets({ ...base, llm_passes: BENCHMARK_TARGETS.pipeline_llm_calls_max })
        .pipeline_llm_calls_le_3,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets({
        ...base,
        llm_passes: BENCHMARK_TARGETS.pipeline_llm_calls_max + 1,
      }).pipeline_llm_calls_le_3,
    ).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, llm_passes: null }).pipeline_llm_calls_le_3).toBe(
      "FAIL",
    );
  });

  test("single_preview demands exactly one preview", () => {
    expect(evaluateBenchmarkTargets({ ...base, previews: 0 }).single_preview).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, previews: 2 }).single_preview).toBe("FAIL");
  });

  test("tool_calls_le_15 boundary: 15 passes, 16 fails, 0 fails (nothing ran)", () => {
    expect(
      evaluateBenchmarkTargets({ ...base, tool_calls: BENCHMARK_TARGETS.tool_calls_max })
        .tool_calls_le_15,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets({ ...base, tool_calls: BENCHMARK_TARGETS.tool_calls_max + 1 })
        .tool_calls_le_15,
    ).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, tool_calls: 0 }).tool_calls_le_15).toBe("FAIL");
  });
});

describe("scoreScenario · authoring", () => {
  test("happy path: stable row shape with every target PASS", () => {
    const score = scoreScenario(SPEC, happyObservation());
    expect(score).toMatchObject({
      scenario: "droplet-specs-email",
      kind: "authoring",
      tool_calls: 4,
      llm_passes: 1,
      judge: "passes",
      wall_ms: 1,
      content_pass: true,
      previews: 1,
      first_preview_content_pass: true,
      guard_fired: null,
      auto_repaired_first_preview: false,
    });
    expect(Object.values(score.targets)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(scenarioPassed(score)).toBe(true);
  });

  test("content failure on the first preview fails content_pass even when the judge passed", () => {
    const obs = happyObservation();
    const preview = obs.results[1]?.output as Record<string, unknown>;
    preview.step_trace = [{ step_id: "send", held_request: { body: { to: "", html: "" } } }];
    const score = scoreScenario(SPEC, obs);
    expect(score.content_pass).toBe(false);
    expect(score.first_preview_content_pass).toBe(false);
    expect(score.targets).toMatchObject({ content_correct_first_preview: "FAIL" });
    expect(score.notes.join(" ")).toContain("failed content checks");
    expect(scenarioPassed(score)).toBe(false);
  });

  test("an auto-repaired first preview is recorded on the score and noted as AUTO-REPAIRED", () => {
    const obs = happyObservation();
    const preview = obs.results[1]?.output as Record<string, unknown>;
    preview.warnings = [
      { step_key: "$output", code: "preview.auto_repaired", message: "repaired" },
    ];
    const score = scoreScenario(SPEC, obs);
    expect(score.auto_repaired_first_preview).toBe(true);
    expect(score.notes.some((n) => n.startsWith("AUTO-REPAIRED"))).toBe(true);
    expect(scenarioPassed(score)).toBe(true);
  });

  test("errored run scores as failed with the error in notes and no crash", () => {
    const score = scoreScenario(SPEC, {
      ...observation(SPEC, []),
      status: "error",
      wall_ms: 12,
      error: "connect ECONNREFUSED",
    });
    expect(score.content_pass).toBe(false);
    expect(score.llm_passes).toBeNull();
    expect(score.previews).toBe(0);
    expect(Object.values(score.targets)).toEqual(["FAIL", "FAIL", "FAIL", "FAIL"]);
    expect(score.notes.join(" ")).toContain("ECONNREFUSED");
  });
});

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

describe("scoreScenario · placeholder answer (negative scenario)", () => {
  const firstTurn = () =>
    turn(
      [call("ask_user_text", ASK_RECIPIENT_AND_SOURCE)],
      "awaiting_input",
      "I need the recipient and the data source first.",
    );
  const gatedAuthor = () =>
    call(
      "author_workflow",
      { goal: "email droplets to test@example.com" },
      {
        ok: false,
        data: {
          error_code: "authoring_definition_invalid",
          requires_user_input: true,
          placeholder_destinations: [
            { step_id: "send", path: "steps.send.body.to", kind: "placeholder_email" },
          ],
        },
      },
    );
  const reAsk = () =>
    call("ask_user_text", {
      question: "test@example.com is a placeholder — which real e-mail address should receive it?",
    });

  test("gate fired, renewed question, no save, no artifacts → PASS with guard_fired=true", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [
        firstTurn(),
        turn([gatedAuthor(), reAsk()], "awaiting_input", "", "elic_2"),
      ]),
    );
    const targets = score.targets as ClarificationTargets;
    expect(targets.placeholder_rejected_after_answer).toBe("PASS");
    expect(score.guard_fired).toBe(true);
    expect(score.notes).toContain("guard_fired=true");
    expect(scenarioPassed(score)).toBe(true);
  });

  test("the dedicated gate code workflow_placeholder_destination also counts as the guard", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [
        firstTurn(),
        turn(
          [
            call(
              "edit_workflow_patch",
              {},
              { ok: false, error_code: "workflow_placeholder_destination" },
            ),
            reAsk(),
          ],
          "awaiting_input",
          "",
          "elic_2",
        ),
      ]),
    );
    expect(score.guard_fired).toBe(true);
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("PASS");
  });

  test("model refuses without touching an authoring tool and asks again → PASS, guard_fired=false", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [
        firstTurn(),
        turn([reAsk()], "awaiting_input", "That looks like a placeholder address.", "elic_2"),
      ]),
    );
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("PASS");
    expect(score.guard_fired).toBe(false);
    expect(score.notes).toContain("guard_fired=false");
    expect(scenarioPassed(score)).toBe(true);
  });

  test("a refusal that names the placeholder only in the assistant text still counts", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [
        firstTurn(),
        turn(
          [call("ask_user_text", { question: "Which real inbox should receive the report?" })],
          "awaiting_input",
          "test@example.com is a placeholder address, so I did not build the workflow.",
          "elic_2",
        ),
      ]),
    );
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("PASS");
    expect(score.guard_fired).toBe(false);
  });

  test("an unrelated renewed question after the placeholder answer is not a refusal → FAIL", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [
        firstTurn(),
        turn(
          [call("ask_user_text", { question: "Which subject line should the e-mail carry?" })],
          "awaiting_input",
          "",
          "elic_2",
        ),
      ]),
    );
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("FAIL");
    expect(score.guard_fired).toBe(false);
    expect(score.notes.join(" ")).toContain(
      "renewed question does not address the placeholder test@example.com",
    );
    expect(scenarioPassed(score)).toBe(false);
  });

  test("a save after the placeholder answer fails even when the gate fired earlier", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(
        NEGATIVE_SPEC,
        [
          firstTurn(),
          turn(
            [
              gatedAuthor(),
              call("author_workflow", {}, { attempts: 1 }),
              call("dry_run_workflow", {}, { judge: { verdict: "passes" } }),
              call("save_workflow_draft", {}, { ok: true, data: { workflow_id: "wf_9" } }),
            ],
            "committed",
          ),
        ],
        { committed_workflow_id: "wf_9" },
      ),
    );
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("FAIL");
    expect(score.guard_fired).toBe(true);
    expect(score.notes.join(" ")).toContain("saved after a placeholder answer");
    expect(scenarioPassed(score)).toBe(false);
  });

  test("authoring went through without gate or renewed question → FAIL", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [
        firstTurn(),
        turn(
          [
            call("author_workflow", {}, { attempts: 1 }),
            call("dry_run_workflow", {}, { judge: { verdict: "passes" } }),
          ],
          "active",
          "Here is the preview.",
          null,
        ),
      ]),
    );
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("FAIL");
    expect(score.guard_fired).toBe(false);
    expect(score.notes.join(" ")).toContain("neither gated nor refused");
  });

  test("created artifacts after the answer fail the target even with gate and renewed question", () => {
    const score = scoreScenario(
      NEGATIVE_SPEC,
      observation(NEGATIVE_SPEC, [firstTurn(), turn([gatedAuthor(), reAsk()], "awaiting_input")], {
        created_artifacts: [
          { kind: "conversation", id: "conv_1" },
          { kind: "knowledge_source", id: "ks_1" },
        ],
      }),
    );
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("FAIL");
    expect(score.notes.join(" ")).toContain("knowledge_source:ks_1");
  });

  test("no turn after the answer → FAIL", () => {
    const score = scoreScenario(NEGATIVE_SPEC, observation(NEGATIVE_SPEC, [firstTurn()]));
    expect((score.targets as ClarificationTargets).placeholder_rejected_after_answer).toBe("FAIL");
    expect(score.notes.join(" ")).toContain("no turn observed after the answer");
  });

  test("a scenario without answer_turns never carries the negative target", () => {
    const score = scoreScenario(CLARIFY_SPEC, observation(CLARIFY_SPEC, [firstTurn()]));
    expect("placeholder_rejected_after_answer" in score.targets).toBe(false);
  });
});

describe("buildLiveReport", () => {
  test("aggregates pass/fail, keeps the stable per-scenario keys and carries trials and cleanup", () => {
    const good = scoreScenario(SPEC, happyObservation());
    const bad = scoreScenario(SPEC, { ...observation(SPEC, []), status: "error", error: "boom" });
    const report = buildLiveReport({
      scores: [good, bad],
      engine_host: "engine.example.com",
      started_at: "2026-06-12T00:00:00.000Z",
      finished_at: "2026-06-12T00:05:00.000Z",
      trials: [aggregateTrials([good, bad])],
      cleanup: { deleted: 3, failures: [] },
    });
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.trials?.[0]?.pass_rate).toBeCloseTo(0.5, 5);
    expect(report.cleanup).toEqual({ deleted: 3, failures: [] });
    for (const key of [
      "scenario",
      "kind",
      "tool_calls",
      "llm_passes",
      "judge",
      "wall_ms",
      "content_pass",
      "previews",
      "guard_fired",
      "auto_repaired_first_preview",
      "targets",
    ]) {
      expect(Object.keys(report.scenarios[0] ?? {})).toContain(key);
    }
  });
});

describe("live scenario specs", () => {
  test("bounded set, unique slugs, exactly two clarification scenarios of which one answers with a placeholder", () => {
    expect(LIVE_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    expect(LIVE_SCENARIOS.length).toBeLessThanOrEqual(10);
    expect(new Set(LIVE_SCENARIOS.map((s) => s.slug)).size).toBe(LIVE_SCENARIOS.length);
    const clarifications = LIVE_SCENARIOS.filter((s) => s.kind === "clarification");
    expect(clarifications.map((s) => s.slug).sort()).toEqual([
      "underspecified-asks-first",
      "underspecified-placeholder-rejected",
    ]);
    expect(
      clarifications.filter((s) => (s.answer_turns?.length ?? 0) > 0).map((s) => s.slug),
    ).toEqual(["underspecified-placeholder-rejected"]);
    expect(LIVE_SCENARIOS.some((s) => s.slug === "underspecified-judge-block")).toBe(false);
  });

  test("every content check compiles once {recipient} is bound", () => {
    for (const raw of LIVE_SCENARIOS) {
      const spec = bindScenarioInputs(raw, { recipient: "ops@acme.test" });
      for (const check of spec.content_checks) {
        expect(() => new RegExp(check.pattern, check.flags ?? "")).not.toThrow();
      }
    }
  });

  test("the droplet-specs scenario takes its recipient from the runner, never a fabricated address", () => {
    const spec = LIVE_SCENARIOS.find((s) => s.slug === "droplet-specs-email");
    expect(spec?.goal).toContain("{recipient}");
    expect(spec?.goal).not.toContain("example.com");
    expect(specNeedsRecipient(spec as LiveScenarioSpec)).toBe(true);
    expect(LIVE_SCENARIOS.filter(specNeedsRecipient).map((s) => s.slug)).toEqual([
      "droplet-specs-email",
    ]);
  });

  test("the placeholder-rejected scenario answers with the placeholder the engine must refuse", () => {
    const spec = LIVE_SCENARIOS.find((s) => s.slug === "underspecified-placeholder-rejected");
    expect(spec?.answer_turns).toEqual([
      "Send it to test@example.com by a plain HTTP POST to https://hooks.example.com/report with a JSON body {to, subject, rows}. The data is the first 5 posts from https://jsonplaceholder.typicode.com/posts (id and title). Subject: Post report. No schedule, I run it on demand. That is everything, build and preview it now.",
    ]);
    expect(spec?.connectors).toEqual([]);
  });
});

describe("scoreScenario · convergence metric (previews_to_pass / converged)", () => {
  const FINAL_SPEC: LiveScenarioSpec = {
    slug: "conv-probe",
    kind: "authoring",
    goal: "return an object with spread_c",
    connectors: ["open-meteo"],
    content_source: "final_output",
    content_checks: [{ name: "spread numeric", pattern: '"spread_c"\\s*:\\s*-?\\d+(\\.\\d+)?' }],
  };
  const preview = (final_output: unknown) => call("dry_run_workflow", {}, { final_output });

  test("first preview wrong, second correct → converged, previews_to_pass=2, first-shot still false", () => {
    const score = scoreScenario(
      FINAL_SPEC,
      observation(FINAL_SPEC, [
        turn(
          [
            call("author_workflow", {}, { attempts: 1 }),
            preview({ spread_c: null }),
            preview({ spread_c: 3.4 }),
          ],
          "committed",
        ),
      ]),
    );
    expect(score.first_preview_content_pass).toBe(false);
    expect(score.converged).toBe(true);
    expect(score.previews_to_pass).toBe(2);
  });

  test("all previews wrong → not converged, previews_to_pass null", () => {
    const score = scoreScenario(
      FINAL_SPEC,
      observation(FINAL_SPEC, [
        turn([preview({ spread_c: null }), preview({ spread_c: null })], "awaiting_input"),
      ]),
    );
    expect(score.converged).toBe(false);
    expect(score.previews_to_pass).toBeNull();
  });

  test("right first shot → previews_to_pass=1", () => {
    const score = scoreScenario(
      FINAL_SPEC,
      observation(FINAL_SPEC, [turn([preview({ spread_c: 5.5 })], "committed")]),
    );
    expect(score.previews_to_pass).toBe(1);
    expect(score.converged).toBe(true);
    expect(score.first_preview_content_pass).toBe(true);
  });
});

describe("scoreScenario · trajectory metrics (probe_before_author / dry_run_before_save)", () => {
  const SPEC2: LiveScenarioSpec = {
    slug: "traj",
    kind: "authoring",
    goal: "build something",
    connectors: ["x"],
    content_checks: [],
  };
  const obs = (tools: string[]): ScenarioObservation =>
    observation(SPEC2, [
      turn(
        tools.map((t) => call(t)),
        "committed",
      ),
    ]);

  test("probe before author → true", () => {
    expect(
      scoreScenario(SPEC2, obs(["probe_connector", "author_workflow"])).probe_before_author,
    ).toBe(true);
  });
  test("author before any probe → false", () => {
    expect(
      scoreScenario(SPEC2, obs(["author_workflow", "probe_connector"])).probe_before_author,
    ).toBe(false);
  });
  test("no author step → null", () => {
    expect(
      scoreScenario(SPEC2, obs(["probe_connector", "list_connectors"])).probe_before_author,
    ).toBeNull();
  });
  test("dry_run before save → true", () => {
    expect(
      scoreScenario(SPEC2, obs(["dry_run_workflow", "save_workflow_draft"])).dry_run_before_save,
    ).toBe(true);
  });
  test("save with no preceding dry_run → false", () => {
    expect(
      scoreScenario(SPEC2, obs(["author_workflow", "save_workflow_draft"])).dry_run_before_save,
    ).toBe(false);
  });
  test("no explicit save (auto-commit path) → true", () => {
    expect(
      scoreScenario(SPEC2, obs(["author_workflow", "dry_run_workflow"])).dry_run_before_save,
    ).toBe(true);
  });
  test("edit before the first preview marks the trial NON-ISOLATED", () => {
    expect(
      scoreScenario(SPEC2, obs(["author_workflow", "edit_workflow_patch", "dry_run_workflow"]))
        .notes,
    ).toContainEqual(expect.stringContaining("NON-ISOLATED"));
  });
});

describe("aggregateTrials · rates, not a single run", () => {
  const mk = (over: Partial<LiveScenarioScore>): LiveScenarioScore => ({
    scenario: "s",
    kind: "authoring",
    tool_calls: 10,
    llm_passes: 1,
    judge: "passes",
    wall_ms: 1,
    content_pass: true,
    previews: 1,
    first_preview_content_pass: true,
    converged: true,
    previews_to_pass: 1,
    probe_before_author: true,
    dry_run_before_save: true,
    guard_fired: null,
    auto_repaired_first_preview: false,
    status: "committed",
    targets: {
      pipeline_llm_calls_le_3: "PASS",
      single_preview: "PASS",
      tool_calls_le_15: "PASS",
      content_correct_first_preview: "PASS",
    },
    notes: [],
    ...over,
  });

  test("rates over isolated trials; NON-ISOLATED excluded; median previews_to_pass", () => {
    const agg = aggregateTrials([
      mk({ content_pass: true, previews_to_pass: 1 }),
      mk({ content_pass: false, converged: false, previews_to_pass: null }),
      mk({ content_pass: true, previews_to_pass: 3 }),
      mk({ notes: ["NON-ISOLATED: edit before preview"], content_pass: false }),
    ]);
    expect(agg.n_trials).toBe(3);
    expect(agg.excluded_non_isolated).toBe(1);
    expect(agg.content_pass_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.pass_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.converged_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.median_previews_to_pass).toBe(2);
    expect(agg.guard_fired_rate).toBeNull();
  });

  test("probe_before_author_rate counts only non-null (authored) trials", () => {
    const agg = aggregateTrials([
      mk({ probe_before_author: true }),
      mk({ probe_before_author: false }),
      mk({ probe_before_author: null }),
    ]);
    expect(agg.probe_before_author_rate).toBeCloseTo(1 / 2, 5);
  });

  test("three clarification trials: pass_rate from scenarioPassed, guard_fired_rate over trials that record it", () => {
    const clarify = (over: Partial<LiveScenarioScore>, targets: ClarificationTargets) =>
      mk({
        kind: "clarification",
        llm_passes: null,
        judge: null,
        previews: 0,
        first_preview_content_pass: false,
        converged: false,
        previews_to_pass: null,
        probe_before_author: null,
        targets,
        ...over,
      });
    const pass: ClarificationTargets = {
      single_clarifying_question: "PASS",
      no_authoring_before_answer: "PASS",
      question_names_missing_inputs: "PASS",
      no_placeholder_in_reply: "PASS",
      placeholder_rejected_after_answer: "PASS",
    };
    const agg = aggregateTrials([
      clarify({ guard_fired: true }, pass),
      clarify({ guard_fired: false }, pass),
      clarify(
        { guard_fired: true, content_pass: false },
        { ...pass, question_names_missing_inputs: "FAIL" },
      ),
    ]);
    expect(agg.n_trials).toBe(3);
    expect(agg.pass_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.guard_fired_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.median_previews_to_pass).toBeNull();
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
