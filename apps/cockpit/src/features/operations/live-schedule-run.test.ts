import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import { liveRunSentence } from "./LiveScheduleRun";
import { isLiveOccurrence, liveRunStep, toOccurrence } from "./schedule-model";

const de = (key: TranslationKey, params?: Record<string, string>) => translate("de", key, params);
const en = (key: TranslationKey, params?: Record<string, string>) => translate("en", key, params);

const step = (
  step_key: string,
  status: string,
  started_at: string | null,
  retry_count = 0,
  step_index: number | null = null,
) => ({ step_key, status, started_at, retry_count, step_index });

const base = {
  id: "o1",
  workflow_id: "wf",
  task_id: null,
  due_at: "2026-11-20T07:00:00.000Z",
  started_at: "2026-11-20T07:00:02.000Z",
  reason_code: null,
  skipped_count: 0,
  state: "ran" as const,
};

describe("liveRunStep", () => {
  test("names the step that is running now", () => {
    expect(
      liveRunStep([
        step("fetch_items", "succeeded", "2026-11-20T07:00:03.000Z"),
        step("summarize", "running", "2026-11-20T07:00:09.000Z"),
      ]),
    ).toEqual({ stepKey: "summarize", attempt: 1, startedAt: "2026-11-20T07:00:09.000Z" });
  });

  test("picks the latest running step and counts retries as attempts", () => {
    expect(
      liveRunStep([
        step("notify", "running", "2026-11-20T07:00:20.000Z", 2),
        step("fetch_items", "running", "2026-11-20T07:00:03.000Z"),
      ]),
    ).toMatchObject({ stepKey: "notify", attempt: 3 });
  });

  test("has nothing to show before the first step or after the last", () => {
    expect(liveRunStep([])).toBeNull();
    expect(liveRunStep([step("fetch_items", "succeeded", "2026-11-20T07:00:03.000Z")])).toBeNull();
  });
});

describe("isLiveOccurrence", () => {
  test("only a running workflow run is live", () => {
    expect(
      isLiveOccurrence(toOccurrence({ ...base, execution_id: "ex1", run_outcome: "running" })),
    ).toBe(true);
    expect(
      isLiveOccurrence(toOccurrence({ ...base, execution_id: "ex1", run_outcome: "succeeded" })),
    ).toBe(false);
  });

  test("a running task run has no execution steps to follow", () => {
    const task = toOccurrence({
      ...base,
      workflow_id: null,
      task_id: "task",
      execution_id: null,
      task_run_id: "tr1",
      run_outcome: "running",
    });
    expect(task.runId).toBe("tr1");
    expect(task.executionId).toBeNull();
    expect(isLiveOccurrence(task)).toBe(false);
  });
});

describe("liveRunSentence", () => {
  test("reads the current step in both languages", () => {
    const current = { stepKey: "summarize", attempt: 1, startedAt: null };
    expect(liveRunSentence(de, current)).toBe("Läuft gerade: Schritt „summarize“");
    expect(liveRunSentence(en, current)).toBe("Running now: step “summarize”");
  });

  test("names the attempt on a retry and covers the start", () => {
    expect(liveRunSentence(de, { stepKey: "notify", attempt: 2, startedAt: null })).toBe(
      "Läuft gerade: Schritt „notify“, Versuch 2",
    );
    expect(liveRunSentence(de, null)).toBe("Läuft gerade, der erste Schritt startet gleich");
  });
});
