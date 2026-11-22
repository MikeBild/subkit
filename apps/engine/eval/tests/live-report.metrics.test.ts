import { describe, expect, test } from "bun:test";
import {
  aggregateTrials,
  type ClarificationTargets,
  type LiveScenarioScore,
  type LiveScenarioSpec,
  type ScenarioObservation,
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
      no_needless_question: "PASS",
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
      no_needless_question: "PASS",
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
