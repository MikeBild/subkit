import { describe, expect, test } from "bun:test";
import {
  averageDurationMs,
  groupRunsByDay,
  resultPhrase,
  runStepKindKey,
  stepKindKey,
  stepPhrase,
  stepWrites,
  successRate,
  triggerKindOf,
} from "@/lib/workflow-flow";
import { readStepDefinition } from "@/lib/workflow-steps";

describe("workflow flow phrases", () => {
  test("names a reading and a sending request by its service, never by its step key", () => {
    const read = readStepDefinition({ id: "fetch_pulls", kind: "request", method: "GET" }, 0);
    const send = readStepDefinition({ id: "send_mail", kind: "request", method: "POST" }, 1);
    expect(stepPhrase(read, "GitHub")).toEqual({
      key: "workflowFlow.step.reads",
      values: { service: "GitHub" },
    });
    expect(stepPhrase(send, "Gmail")).toEqual({
      key: "workflowFlow.step.sends",
      values: { service: "Gmail" },
    });
    expect(stepPhrase(read, null)).toEqual({ key: "workflowFlow.step.readsAny" });
    expect(stepPhrase(send, "OpenAI", { kind: "brand", key: "openai" })).toEqual({
      key: "workflowFlow.step.asks",
      values: { service: "OpenAI" },
    });
    expect(JSON.stringify(stepPhrase(read, "GitHub"))).not.toContain("fetch_pulls");
  });

  test("describes code, waiting and branching in plain words", () => {
    expect(stepPhrase(readStepDefinition({ id: "a", kind: "transform" }, 0), null).key).toBe(
      "workflowFlow.step.code",
    );
    expect(
      stepPhrase(readStepDefinition({ id: "w", kind: "wait", duration_ms: 120_000 }, 0), null),
    ).toEqual({ key: "workflowFlow.step.wait", values: { duration: "2 min" } });
    expect(stepPhrase(readStepDefinition({ id: "b", kind: "branch" }, 0), null).key).toBe(
      "workflowFlow.step.branch",
    );
    expect(stepPhrase(readStepDefinition({ id: "x", kind: "mystery" }, 0), null).key).toBe(
      "workflowFlow.step.other",
    );
  });

  test("knows whether a request step sends, preferring the declared side effect", () => {
    expect(stepWrites(readStepDefinition({ id: "a", kind: "request", method: "GET" }, 0))).toBe(
      false,
    );
    expect(stepWrites(readStepDefinition({ id: "a", kind: "request", method: "PATCH" }, 0))).toBe(
      true,
    );
    expect(
      stepWrites(
        readStepDefinition({ id: "a", kind: "request", method: "POST", side_effects: "read" }, 0),
      ),
    ).toBe(false);
    expect(stepWrites(readStepDefinition({ id: "a", kind: "transform" }, 0))).toBeNull();
  });

  test("names the step kind the way the glossary shows it on cards", () => {
    const read = readStepDefinition({ id: "a", kind: "request", method: "GET" }, 0);
    const send = readStepDefinition({ id: "b", kind: "request", method: "POST" }, 1);
    const github = { kind: "brand", key: "github" } as const;
    expect(stepKindKey(read, github)).toBe("workflow.kind.request");
    expect(stepKindKey(send, github)).toBe("workflow.kind.send");
    expect(stepKindKey(send, { kind: "brand", key: "openai" })).toBe("workflow.kind.askAi");
    expect(stepKindKey(readStepDefinition({ id: "c", kind: "transform" }, 2), null)).toBe(
      "workflow.kind.code",
    );
    expect(stepKindKey(readStepDefinition({ id: "d", kind: "wait" }, 3), null)).toBe(
      "workflow.kind.wait",
    );
  });

  test("a run step uses the same kind names as the flow card", () => {
    expect(runStepKindKey("request", "read", { kind: "brand", key: "github" })).toBe(
      "workflow.kind.request",
    );
    expect(runStepKindKey("request", "write", null)).toBe("workflow.kind.send");
    expect(runStepKindKey("request", "write", { kind: "brand", key: "anthropic" })).toBe(
      "workflow.kind.askAi",
    );
    expect(runStepKindKey("transform", null, null)).toBe("workflow.kind.transform");
  });
});

describe("workflow flow trigger and result", () => {
  test("falls back to on demand for anything that is not a schedule or webhook", () => {
    expect(triggerKindOf({ kind: "schedule" })).toBe("schedule");
    expect(triggerKindOf({ kind: "webhook" })).toBe("webhook");
    expect(triggerKindOf({ kind: "request" })).toBe("request");
    expect(triggerKindOf(null)).toBe("request");
  });

  test("words the declared result without showing its schema", () => {
    expect(resultPhrase(null)).toEqual({ key: "workflowFlow.result.none" });
    expect(resultPhrase({ title: "Report", type: "object" })).toEqual({
      key: "workflowFlow.result.named",
      values: { what: "Report" },
    });
    expect(resultPhrase({ type: "object", properties: { a: {}, b: {} } })).toEqual({
      key: "workflowFlow.result.fields.other",
      values: { count: 2 },
    });
    expect(resultPhrase({ type: "object", properties: { a: {} } })).toEqual({
      key: "workflowFlow.result.fields.one",
      values: { count: 1 },
    });
    expect(resultPhrase({ type: "array" })).toEqual({ key: "workflowFlow.result.list" });
  });
});

describe("workflow run history", () => {
  test("groups runs by local day with today and yesterday named", () => {
    const now = new Date(2026, 9, 22, 12, 0);
    const runs = [
      { id: "a", created_at: new Date(2026, 9, 22, 7, 0).toISOString() },
      { id: "b", created_at: new Date(2026, 9, 21, 9, 0).toISOString() },
      { id: "c", started_at: new Date(2026, 9, 19, 9, 0).toISOString(), created_at: "" },
      { id: "d", created_at: new Date(2026, 9, 19, 8, 0).toISOString() },
    ];
    const groups = groupRunsByDay(runs, now);
    expect(groups.map((group) => group.label.kind)).toEqual(["today", "yesterday", "date"]);
    expect(groups.map((group) => group.items.map((run) => run.id))).toEqual([
      ["a"],
      ["b"],
      ["c", "d"],
    ]);
  });

  test("computes a success rate and an average only from known values", () => {
    expect(successRate(10, 2)).toBe(80);
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(undefined, 0)).toBeNull();
    expect(averageDurationMs([1000, null, 3000])).toBe(2000);
    expect(averageDurationMs([null])).toBeNull();
  });
});
