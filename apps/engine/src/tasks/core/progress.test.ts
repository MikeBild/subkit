import { describe, expect, test } from "bun:test";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import {
  TASK_RUN_ACTING_TOOLS,
  taskPlaybookProgressMarks,
  taskRunCallMarks,
  taskRunProgress,
  taskRunToolCallActs,
} from "./progress.ts";

describe("taskPlaybookProgressMarks", () => {
  test.each([
    [{ ready_steps: 0, fresh_evidence_ids: [], results: [] }, []],
    [{ ready_steps: 1, fresh_evidence_ids: [], results: [] }, ["ready:1"]],
    [{ ready_steps: 3, fresh_evidence_ids: [], results: [] }, ["ready:1", "ready:2", "ready:3"]],
    [
      { ready_steps: 0, fresh_evidence_ids: ["e1", "e2"], results: [] },
      ["evidence:e1", "evidence:e2"],
    ],
    [
      { ready_steps: 0, fresh_evidence_ids: [], results: ["Done.", ""] },
      [`result:${workflowJsonDigest("Done.")}`, `result:${workflowJsonDigest("")}`],
    ],
    [
      { ready_steps: 1, fresh_evidence_ids: ["e1"], results: ["Done."] },
      ["ready:1", "evidence:e1", `result:${workflowJsonDigest("Done.")}`],
    ],
  ])("%j -> %j", (playbook, expected) => {
    expect(taskPlaybookProgressMarks(playbook)).toEqual(expected);
  });

  test("a result is named by its content, not by its text", () => {
    const [mark] = taskPlaybookProgressMarks({
      ready_steps: 0,
      fresh_evidence_ids: [],
      results: ["x".repeat(5_000)],
    });
    expect(mark).toBe(`result:${workflowJsonDigest("x".repeat(5_000))}`);
    expect(mark).toHaveLength("result:".length + 64);
  });
});

describe("taskRunToolCallActs", () => {
  test.each([
    ["wf_weather", "ok", true],
    ["wf_", "ok", true],
    ["run_workflow", "ok", true],
    ["call_connector", "ok", true],
    ["probe_connector", "ok", true],
    ["wf_weather", "error", false],
    ["call_connector", "denied", false],
    ["run_workflow", null, false],
    ["update_playbook", "ok", false],
    ["inspect_playbook", "ok", false],
    ["ask_user_confirm", "ok", false],
    ["get_execution", "ok", false],
    ["xwf_weather", "ok", false],
  ] as const)("%s with outcome %p acts: %p", (tool, outcome, acts) => {
    expect(taskRunToolCallActs({ tool, outcome })).toBe(acts);
  });

  test("the acting tools are the ones that run a bound workflow or connector", () => {
    expect([...TASK_RUN_ACTING_TOOLS]).toEqual([
      "run_workflow",
      "call_connector",
      "probe_connector",
    ]);
  });
});

describe("taskRunCallMarks", () => {
  test("every acting call is its own mark, in the order given; other calls leave none", () => {
    expect(taskRunCallMarks([])).toEqual([]);
    expect(
      taskRunCallMarks([
        { id: "1", tool: "inspect_playbook", outcome: "ok" },
        { id: "2", tool: "wf_weather", outcome: "ok" },
        { id: "3", tool: "wf_weather", outcome: "ok" },
        { id: "4", tool: "call_connector", outcome: "error" },
        { id: "5", tool: "call_connector", outcome: "ok" },
      ]),
    ).toEqual(["call:2", "call:3", "call:5"]);
  });
});

describe("taskRunProgress", () => {
  test.each([
    [[], [], [], false],
    [[], ["ready:1"], ["ready:1"], true],
    [["ready:1"], [], ["ready:1"], false],
    [["ready:1"], ["ready:1"], ["ready:1"], false],
    [["ready:1", "result:a"], ["result:a", "ready:1"], ["ready:1", "result:a"], false],
    [["ready:1", "result:a"], ["result:b"], ["ready:1", "result:a", "result:b"], true],
    [["result:a"], ["result:b", "result:b"], ["result:a", "result:b"], true],
    [["result:a", "result:a"], ["result:a"], ["result:a"], false],
    [["call:1"], ["call:1", "call:2"], ["call:1", "call:2"], true],
  ] as const)("seen %j, observed %j", (seen, observed, marks, progressed) => {
    expect(taskRunProgress(seen, observed)).toEqual({ progress_marks: [...marks], progressed });
  });
});
