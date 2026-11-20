import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type TranslationKey, translate } from "@/lib/i18n";
import type { ConversationPlaybook, PlaybookStep } from "./chat-playbook";
import { isRunContinuation, RUN_CONFIRM_STEP_ID, runLine, runNowStep } from "./chat-task-run";
import { latestRun, run, task } from "./tasks-fixtures";
import { historyLabelKey, historyTitle } from "./tasks-history";
import {
  actionKey,
  formPlan,
  matchesFilter,
  stateWords,
  summaryParts,
  TASK_RESULT_STEP_ID,
  taskCounts,
  taskRows,
  taskStatus,
} from "./tasks-model";
import { stepLines, stepMarkKey, stepResults } from "./tasks-steps";
import {
  limitEndedLine,
  RUN_LIMIT_CODES,
  WAITING_REASONS,
  waitingForKey,
  waitingStateKey,
  waitingView,
  waitsForPerson,
} from "./tasks-waiting";

const t =
  (locale: "de" | "en") => (key: TranslationKey, values?: Record<string, string | number>) =>
    translate(locale, key, values);
const de = t("de");
const en = t("en");

const API = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../../../packages/cli-core/src/engine-api/openapi.json"),
    "utf8",
  ),
) as {
  components: { schemas: Record<string, { properties: Record<string, { enum?: unknown[] }> }> };
};

const step = (id: string, status: PlaybookStep["status"], label = id): PlaybookStep =>
  ({
    id,
    label,
    criterion: "",
    depends_on: [],
    status,
    reason: "",
    assurance: "technical",
    evidence: [],
    next_action: null,
  }) as PlaybookStep;

const plan = (steps: PlaybookStep[], next: string | null = null): ConversationPlaybook =>
  ({
    id: "p",
    title: "T",
    goal: "Ziel",
    revision: 1,
    status: "in_progress",
    summary: "",
    steps,
    next_action: next ? { label: next, owner: null, elicitation_id: null } : null,
    completion: { status: "open", label: "", reason: "" },
    updated_at: "2026-11-19T09:00:00Z",
  }) as ConversationPlaybook;

describe("what a waiting run waits for", () => {
  const status = (waiting_reason: (typeof WAITING_REASONS)[number]) =>
    taskStatus({ task: task(), run: run({ state: "waiting", waiting_reason }), grantLive: null });

  test("every reason the engine knows has a tile word, a sentence and exactly one action", () => {
    const known = (API.components.schemas.TaskRun?.properties.waiting_reason?.enum ?? []).filter(
      (value): value is string => typeof value === "string",
    );
    expect([...WAITING_REASONS].sort() as string[]).toEqual([...known].sort());
    const table = WAITING_REASONS.map((reason) => [
      reason,
      de(waitingForKey({ state: "waiting", waiting_reason: reason }) as TranslationKey),
      de(actionKey(status(reason).action as "answer")),
    ]);
    expect(table).toEqual([
      ["question", "dich", "Antworten"],
      ["approval", "dich", "Antworten"],
      ["question_expired", "dich", "Antworten"],
      ["no_progress", "dich", "Fortsetzen"],
      ["turn_stopped", "dich", "Fortsetzen"],
      ["budget", "KI-Kontingent", "Nutzung ansehen"],
      ["ai_access", "KI-Zugang", "KI-Zugang einrichten"],
    ]);
    expect(new Set(WAITING_REASONS.map((reason) => status(reason).line)).size).toBe(7);
    expect(en(actionKey("usage"))).toBe("View usage");
    expect(en(actionKey("ai_access"))).toBe("Set up AI access");
    expect(en(actionKey("continue"))).toBe("Resume");
  });

  test("a budget or access wait is not the person's turn and says it continues by itself", () => {
    for (const reason of ["budget", "ai_access"] as const) {
      const glance = { state: "waiting", waiting_reason: reason };
      expect(waitsForPerson(glance)).toBe(false);
      expect(status(reason).tone).toBe("info");
      expect(de(status(reason).line)).toContain("läuft von selbst weiter");
      expect(en(status(reason).line)).toContain("continues on its own");
      expect(waitingStateKey(glance)).not.toBeNull();
      const row = { task: task(), run: latestRun(run(glance as never)) };
      expect(matchesFilter(row, "waiting")).toBe(false);
      const counts = taskCounts(taskRows([{ ...row.task, latest_run: row.run }]));
      expect(counts).toMatchObject({ working: 0, waiting: 0, ai: 1 });
      expect(summaryParts(counts).map((part) => part.key)).toEqual(["tasks.summary.ai"]);
    }
    expect(
      stateWords(
        "waiting",
        { next_check_at: null, waiting_reason: "budget" },
        {
          t: de,
          time: String,
        },
      ),
    ).toBe("wartet auf KI-Kontingent");
    expect(
      stateWords(
        "waiting",
        { next_check_at: null, waiting_reason: "question" },
        {
          t: de,
          time: String,
        },
      ),
    ).toBe("wartet auf dich");
    expect(translate("de", "tasks.summary.ai.one", { count: 1 })).toBe("1 wartet auf die KI");
    expect(translate("en", "tasks.summary.ai.other", { count: 2 })).toBe("2 waiting for AI");
    expect(waitingView("something_new").action).toBe("answer");
    expect(waitingForKey({ state: "result_ready" })).toBe("tasks.overview.waiting.you");
    expect(waitingForKey({ state: "running" })).toBeNull();
    expect(waitingStateKey({ state: "waiting", waiting_reason: "question" })).toBeNull();
  });
});

describe("the run line and the detail page share their words", () => {
  const stale = plan(
    [
      step("fetch", "stale", "Wetter abrufen"),
      step("work", "blocked", "Zusammenfassen"),
      step(RUN_CONFIRM_STEP_ID, "blocked"),
    ],
    "Zusammenfassung bestätigen",
  );

  test("a waiting run never names a step that is not waiting; it names the next action", () => {
    expect(runNowStep(stale, "waiting", de, "question")).toBe("Zusammenfassung bestätigen");
    expect(runNowStep(plan(stale.steps), "waiting", de, "question")).toBeNull();
    const asking = plan([step("ask", "waiting_for_input", "Rückfrage klären")], "Anderes");
    expect(runNowStep(asking, "waiting", de, "question")).toBe("Rückfrage klären");
    expect(runNowStep(stale, "running", de)).toBe("Wetter abrufen");
  });

  test("a budget wait shows its own state word and no step", () => {
    for (const [reason, word] of [
      ["budget", "wartet auf KI-Kontingent"],
      ["ai_access", "wartet auf KI-Zugang"],
    ] as const) {
      expect(runNowStep(stale, "waiting", de, reason)).toBeNull();
      const line = runLine(
        {
          run: { state: "waiting", waiting_reason: reason, next_check_at: null },
          playbook: stale,
          now: 0,
        },
        "de",
        de,
      );
      expect(line).toEqual({ state: { label: word, badge: "pending" }, facts: [] });
    }
    const asked = runLine(
      {
        run: { state: "waiting", waiting_reason: "question", next_check_at: null },
        playbook: stale,
        now: 0,
      },
      "en",
      en,
    );
    expect(asked.state).toEqual({ label: "waiting for you", badge: "awaiting_input" });
    expect(asked.facts).toEqual(["Now: Zusammenfassung bestätigen"]);
  });

  test("a continuation is recognized by its origin field only, never by its text", () => {
    expect(isRunContinuation({ role: "user", origin: "task_run_continuation", parts: [] })).toBe(
      true,
    );
    expect(
      isRunContinuation({
        role: "user",
        parts: [{ type: "text", text: "Continue working on the task." }],
      }),
    ).toBe(false);
    expect(isRunContinuation(null)).toBe(false);
  });
});

describe("steps on the overview", () => {
  const taskPlan = formPlan("T", "Ziel", "Fertig");

  test("without a run every step is open and the confirmation is last", () => {
    expect(stepLines(taskPlan, null)).toEqual([
      { id: "work", label: "Ziel", mark: "open" },
      { id: TASK_RESULT_STEP_ID, label: null, mark: "open" },
    ]);
    expect(stepLines(taskPlan, [])).toHaveLength(2);
  });

  test("a run brings its step states, and the confirmation stays last whatever the order", () => {
    const live = [
      { id: TASK_RESULT_STEP_ID, label: "Ziel", status: "blocked" as const },
      { id: "a", label: "A", status: "verified" as const },
      { id: "b", label: "B", status: "in_progress" as const },
      { id: "c", label: "C", status: "waiting_for_input" as const },
      { id: "d", label: "D", status: "blocked" as const },
    ];
    expect(stepLines(taskPlan, live, "running").map((line) => [line.label, line.mark])).toEqual([
      ["A", "done"],
      ["B", "active"],
      ["C", "waiting"],
      ["D", "open"],
      [null, "open"],
    ]);
    expect(stepLines(taskPlan, live, "result_ready").at(-1)?.mark).toBe("waiting");
    expect(stepLines(taskPlan, live, "completed").at(-1)?.mark).toBe("done");
    for (const mark of ["done", "active", "waiting", "open"] as const)
      expect(de(stepMarkKey(mark))).not.toBe("");
  });

  test("the delivered results of assessment steps are what the review shows", () => {
    expect(
      stepResults([
        { id: "fetch", label: "Abrufen", status: "verified", assurance: "technical", reason: "ok" },
        {
          id: "work",
          label: " Zusammenfassen ",
          status: "assessment_ready",
          assurance: "assessment",
          reason: " 6,4 °C, Wind 12,7 km/h. ",
        },
        { id: "later", label: "Später", status: "open", assurance: "assessment", reason: "Notiz" },
        {
          id: TASK_RESULT_STEP_ID,
          label: "Ziel",
          status: "assessment_ready",
          assurance: "assessment",
          reason: "x",
        },
      ]),
    ).toEqual([{ id: "work", label: "Zusammenfassen", text: "6,4 °C, Wind 12,7 km/h." }]);
    expect(stepResults(null)).toEqual([]);
  });
});

describe("a run that ended at one of its limits", () => {
  const ended = (failure_code: string | null, state = "failed") =>
    taskStatus({
      task: task(),
      run: { ...run({ state: state as "failed" }), failure_code },
      grantLive: null,
    });

  test("every limit the engine ends a run at has its own sentence and offers a new start, never to continue", () => {
    const known = (API.components.schemas.TaskRun?.properties.failure_code?.enum ?? []).filter(
      (value): value is string => typeof value === "string",
    );
    for (const code of RUN_LIMIT_CODES) expect(known).toContain(code);
    const table = RUN_LIMIT_CODES.map((code) => {
      const status = ended(code);
      return [
        code,
        status.kind,
        status.tone,
        de(status.line),
        en(status.line),
        de(actionKey(status.action as "restart")),
        en(actionKey(status.action as "restart")),
      ];
    });
    expect(table).toEqual([
      [
        "turn_limit_reached",
        "failed",
        "error",
        "Der Lauf hat sein Rundenlimit erreicht und wurde beendet.",
        "The run reached its round limit and has ended.",
        "Neu starten",
        "Start again",
      ],
      [
        "deadline_exceeded",
        "failed",
        "error",
        "Der Lauf hat seine Frist erreicht und wurde beendet.",
        "The run reached its time limit and has ended.",
        "Neu starten",
        "Start again",
      ],
    ]);
  });

  test("another failure keeps its line and action, and a limit code on a run that did not fail means nothing", () => {
    expect(ended("turn_failed")).toMatchObject({ line: "tasks.strip.failed", action: "view" });
    expect(ended(null)).toMatchObject({ line: "tasks.strip.failed", action: "view" });
    expect(limitEndedLine({ state: "failed", failure_code: "turn_limit_reached" })).toBe(
      "tasks.strip.limit.turns",
    );
    expect(limitEndedLine({ state: "waiting", failure_code: "turn_limit_reached" })).toBeNull();
    expect(limitEndedLine({ state: "failed", failure_code: "toString" })).toBeNull();
    expect(limitEndedLine({ state: "failed" })).toBeNull();
    expect(limitEndedLine(null)).toBeNull();
    expect(ended("turn_limit_reached", "waiting").action).not.toBe("restart");
  });
});

describe("history on the task page", () => {
  test("run events are short because the task is known, and carry their reason", () => {
    const titles = (
      [
        { action: "task_run.started" },
        { action: "task_run.waiting", details: { state: "waiting", waiting_reason: "question" } },
        { action: "task_run.waiting", details: { state: "waiting", waiting_reason: "budget" } },
        { action: "task_run.waiting", reason: "ai_access", details: {} },
        {
          action: "task_run.waiting",
          details: { state: "sleeping", waiting_reason: null, sleep_reason: "check_requested" },
        },
        { action: "task_run.resumed", details: { resume_reason: "question" } },
        { action: "task_run.failed", details: { failure_code: "deadline_exceeded" } },
        { action: "task_run.failed", details: { failure_code: "turn_limit_reached" } },
        { action: "task_run.waiting", details: { waiting_reason: "brand_new_code" } },
        { action: "task.created" },
        { action: "task.future" },
      ] as const
    ).map((entry) => historyTitle(entry, de));
    expect(titles).toEqual([
      "Lauf gestartet",
      "Lauf wartet · Rückfrage",
      "Lauf wartet · KI-Kontingent",
      "Lauf wartet · KI-Zugang",
      "Lauf schläft · Nächste Prüfung geplant",
      "Lauf fortgesetzt",
      "Lauf fehlgeschlagen · Die Frist ist abgelaufen",
      "Lauf fehlgeschlagen · Das Rundenlimit ist erreicht",
      "Lauf wartet",
      de("audit.action.taskCreated"),
      "Weiteres Ereignis",
    ]);
    expect(
      historyTitle({ action: "task_run.waiting", details: { waiting_reason: "budget" } }, en),
    ).toBe("Run waiting · AI allowance");
    for (const action of [
      "started",
      "waiting",
      "resumed",
      "result_ready",
      "completed",
      "failed",
      "abort_requested",
      "aborted",
    ]) {
      const key = historyLabelKey({ action: `task_run.${action}` });
      expect(key).toBe(`tasks.history.run.${action}` as TranslationKey);
      expect(de(key)).not.toContain("einer Aufgabe");
    }
  });
});
