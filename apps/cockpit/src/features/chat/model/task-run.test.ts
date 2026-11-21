import { describe, expect, test } from "bun:test";
import { CATALOGS, LOCALES, type TranslationKey, translate } from "@/lib/i18n";
import type { ConversationPlaybook, PlaybookStep } from "./playbook";
import { playbookStatusKey, playbookStepStatusKey } from "./playbook";
import {
  newerPlaybook,
  RUN_CONFIRM_STEP_ID,
  runBadgeState,
  runCanAbort,
  runCheckLabel,
  runDateLabel,
  runIsOpen,
  runLine,
  runMarker,
  runNowStep,
  runPlaybook,
  runStateKey,
} from "./task-run";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const TASK = "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa";
const RUN = "018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb";
const GOAL = "Offene Rechnungen nachfassen, bis sie bezahlt sind.";
const STATES = ["running", "waiting", "sleeping", "result_ready", "completed", "aborted", "failed"];

const step = (id: string, status: PlaybookStep["status"], label = id): PlaybookStep => ({
  id,
  label,
  criterion: `${label} is evidenced`,
  depends_on: [],
  status,
  reason: "engine reason",
  assurance: "technical",
  evidence: [],
  next_action: null,
});

const confirm = (status: PlaybookStep["status"]): PlaybookStep => ({
  ...step(RUN_CONFIRM_STEP_ID, status, GOAL),
  criterion: GOAL,
  assurance: "human",
  reason: status === "blocked" ? "Ein vorausgehender Prüfschritt ist noch offen." : "engine reason",
});

const plan = (
  status: ConversationPlaybook["status"],
  steps: PlaybookStep[],
  summary = "engine summary",
): ConversationPlaybook => ({
  id: "playbook",
  title: "Rechnungen nachfassen",
  goal: GOAL,
  revision: 1,
  status,
  summary,
  steps,
  next_action: null,
  completion: { status: "open", label: "completion", reason: "open" },
  updated_at: "2026-11-19T08:00:00Z",
});

describe("finding the run of a conversation", () => {
  test("the marker of the stored session names the task and the run", () => {
    expect(runMarker({ session: { task_run: { task_id: TASK, task_run_id: RUN } } })).toEqual({
      taskId: TASK,
      taskRunId: RUN,
    });
  });

  test("an ordinary conversation has no run", () => {
    for (const draft of [null, undefined, "x", [], {}, { session: null }, { session: {} }])
      expect(runMarker(draft)).toBeNull();
    expect(runMarker({ session: { title: "x" } })).toBeNull();
  });

  test("a marker that does not read stays a run conversation, without ids to look up", () => {
    for (const marker of [
      null,
      "sealed",
      {},
      { task_id: TASK },
      { task_id: "nope", task_run_id: RUN },
      { task_id: TASK, task_run_id: 7 },
    ])
      expect(runMarker({ session: { task_run: marker } })).toEqual({
        taskId: null,
        taskRunId: null,
      });
  });
});

describe("the state of a run", () => {
  test("every state the engine persists has a word in both languages", () => {
    for (const state of STATES) {
      const key = runStateKey(state);
      expect(key).not.toBeNull();
      for (const locale of LOCALES)
        expect(CATALOGS[locale][key as TranslationKey].trim()).not.toBe("");
    }
    expect(de("chat.taskRun.state.waiting")).toBe("wartet auf dich");
    expect(en("chat.taskRun.state.result_ready")).toBe("result ready");
    expect(runStateKey("future")).toBeNull();
    expect(runStateKey("constructor")).toBeNull();
  });

  test("the badge tone follows the state, an unknown one stays neutral", () => {
    expect(STATES.map(runBadgeState)).toEqual([
      "running",
      "awaiting_input",
      "pending",
      "pending",
      "completed",
      "aborted",
      "failed",
    ]);
    expect(runBadgeState("future")).toBe("pending");
    expect(runBadgeState("toString")).toBe("pending");
  });

  test("only an open run can be stopped, and only with the right to do so", () => {
    expect(STATES.filter(runIsOpen)).toEqual(["running", "waiting", "sleeping"]);
    for (const state of STATES) {
      expect(runCanAbort(state, ["task_run:abort"])).toBe(runIsOpen(state));
      expect(runCanAbort(state, ["task_run:read", "task:run"])).toBe(false);
    }
  });
});

describe("what the run is doing now", () => {
  const working = plan("blocked", [
    step("find", "verified", "Offene finden"),
    step("remind", "in_progress", "Erinnerungen vorbereiten"),
    step("check", "open", "Zahlung prüfen"),
    confirm("blocked"),
  ]);

  test("names the step in progress", () => {
    expect(runNowStep(working, "running", de)).toBe("Erinnerungen vorbereiten");
  });

  test("falls back to a waiting step, then to the first unsettled one", () => {
    const waiting = plan("waiting_for_input", [
      step("find", "verified"),
      step("ask", "waiting_for_input", "Rückfrage klären"),
      confirm("blocked"),
    ]);
    expect(runNowStep(waiting, "waiting", de)).toBe("Rückfrage klären");
    const fresh = plan("blocked", [
      step("skip", "not_applicable"),
      step("ready", "assessment_ready"),
      step("next", "blocked", "Zahlung prüfen"),
      confirm("blocked"),
    ]);
    expect(runNowStep(fresh, "sleeping", de)).toBe("Zahlung prüfen");
  });

  test("with all work settled, the result review is what is due", () => {
    const done = plan("in_progress", [step("find", "verified"), confirm("open")]);
    expect(runNowStep(done, "result_ready", de)).toBe("Ergebnis prüfen");
    expect(runNowStep(done, "result_ready", en)).toBe("Review result");
  });

  test("an ended run, a missing playbook or a plan without the review step says nothing", () => {
    for (const state of ["completed", "aborted", "failed"])
      expect(runNowStep(working, state, de)).toBeNull();
    expect(runNowStep(null, "running", de)).toBeNull();
    expect(runNowStep(plan("prepared", [step("find", "verified")]), "running", de)).toBeNull();
    expect(runNowStep(plan("open", [step("blank", "open", "  ")]), "running", de)).toBeNull();
  });
});

describe("the playbook of a run in the viewer's language", () => {
  const fresh = plan(
    "blocked",
    [step("find", "open", "Offene finden"), confirm("blocked")],
    `${GOAL}: ${GOAL}`,
  );

  test("the review step is rendered by its id, not by the stored goal", () => {
    const shown = runPlaybook(fresh, de);
    expect(shown.steps[1]).toMatchObject({
      id: RUN_CONFIRM_STEP_ID,
      label: "Ergebnis prüfen",
      criterion:
        "Passt das Ergebnis zum Ziel „Offene Rechnungen nachfassen, bis sie bezahlt sind“?",
      assurance: "human",
    });
    expect(runPlaybook(fresh, en).steps[1]).toMatchObject({
      label: "Review result",
      criterion:
        "Does the result meet the goal “Offene Rechnungen nachfassen, bis sie bezahlt sind”?",
    });
    expect(shown.steps[0]).toBe(fresh.steps[0] as PlaybookStep);
    expect(shown.goal).toBe(GOAL);
  });

  test("a fresh run is open, not blocked: the review simply is not due yet", () => {
    const shown = runPlaybook(fresh, de);
    expect(de(playbookStatusKey(shown))).toBe(de("chat.playbook.status.open"));
    expect(de(playbookStepStatusKey(shown.steps[1] as PlaybookStep))).toBe(
      de("chat.playbook.step.open"),
    );
    expect(shown.steps[1]?.reason).toBe("Kommt dran, sobald die Schritte davor fertig sind.");
    expect(shown.summary).toBe("Die Schritte vor der Ergebnisprüfung laufen noch.");
    expect(runPlaybook(fresh, en).summary).toBe(
      "The steps before the result review are still under way.",
    );
  });

  test("work under way reads as in progress", () => {
    for (const status of ["in_progress", "verified", "assessment_ready"] as const)
      expect(
        runPlaybook(plan("blocked", [step("find", status), confirm("blocked")]), de).status,
      ).toBe("in_progress");
  });

  test("a work step that is really blocked keeps the playbook blocked", () => {
    const stuck = plan("blocked", [
      step("find", "blocked"),
      step("next", "in_progress"),
      confirm("blocked"),
    ]);
    const shown = runPlaybook(stuck, de);
    expect(shown.status).toBe("blocked");
    expect(shown.summary).toBe("engine summary");
    expect(shown.steps[2]?.status).toBe("open");
  });

  test("every other state and the engine's own words pass through", () => {
    for (const status of ["waiting_for_input", "prepared", "completed", "cancelled"] as const)
      expect(
        runPlaybook(plan(status, [step("find", "verified"), confirm("open")]), de),
      ).toMatchObject({ status, summary: "engine summary" });
    const due = runPlaybook(plan("in_progress", [step("find", "verified"), confirm("open")]), de);
    expect(due.steps[1]).toMatchObject({ status: "open", reason: "engine reason" });
    const confirmed = runPlaybook(plan("completed", [confirm("verified")]), de);
    expect(confirmed.steps[0]).toMatchObject({ status: "verified", label: "Ergebnis prüfen" });
  });

  test("the run state is the authority: a completed run reads confirmed and done", () => {
    const stale = plan("blocked", [step("find", "open"), confirm("blocked")]);
    const shown = runPlaybook(stale, de, "completed");
    expect(shown.status).toBe("completed");
    expect(shown.completion.status).toBe("verified");
    expect(de(playbookStatusKey(shown))).toBe(de("chat.playbook.status.completed"));
    expect(shown.steps[1]).toMatchObject({ status: "verified", reason: "" });
    const waiting = runPlaybook(
      plan("in_progress", [confirm("waiting_for_input")]),
      de,
      "completed",
    );
    expect(waiting.steps[0]).toMatchObject({ status: "verified", reason: "engine reason" });
  });

  test("the playbook's own status never speaks for a run", () => {
    const claimed = {
      ...plan("completed", [step("find", "verified"), confirm("verified")]),
      completion: { status: "verified" as const, label: "completion", reason: "done" },
    };
    const ready = runPlaybook(claimed, de, "result_ready");
    expect(ready.status).toBe("waiting_for_input");
    expect(ready.completion.status).toBe("open");
    expect(ready.steps[1]?.status).toBe("waiting_for_input");
    for (const state of ["running", "sleeping"]) {
      const open = runPlaybook(claimed, de, state);
      expect(open.status).toBe("in_progress");
      expect(open.steps[1]?.status).toBe("open");
    }
    expect(runPlaybook(claimed, de, "waiting").status).toBe("waiting_for_input");
    expect(runPlaybook(claimed, de, "aborted").status).toBe("cancelled");
    expect(runPlaybook(claimed, de, "failed").status).toBe("blocked");
    expect(runPlaybook(claimed, de, "unknown").status).toBe("completed");
    const fresh = plan("blocked", [step("find", "open"), confirm("blocked")]);
    expect(runPlaybook(fresh, de, "running").status).toBe("open");
  });

  test("a goal keeps its inner punctuation and loses only the closing mark", () => {
    const asked = { ...fresh, goal: "  Was kostet v1.2? Bitte prüfen…  " };
    expect(runPlaybook(asked, de).steps[1]?.criterion).toBe(
      "Passt das Ergebnis zum Ziel „Was kostet v1.2? Bitte prüfen“?",
    );
  });

  test("a playbook without the review step is not a run playbook and stays as it is", () => {
    const other = plan("blocked", [step("find", "blocked")]);
    expect(runPlaybook(other, de)).toBe(other);
  });
});

describe("the line above the conversation", () => {
  const NOW = Date.parse("2026-11-19T10:00:00Z");
  const playbook = plan("blocked", [
    step("remind", "in_progress", "Erinnerungen vorbereiten"),
    confirm("blocked"),
  ]);

  test("reads state, now and next check, as in the plan", () => {
    expect(
      runLine(
        {
          run: { state: "sleeping", next_check_at: "2026-11-19T14:30:00Z" },
          playbook,
          now: NOW,
          zone: "UTC",
        },
        "de",
        de,
      ),
    ).toEqual({
      state: { label: "schläft", badge: "pending" },
      facts: ["Jetzt: Erinnerungen vorbereiten", "Nächste Prüfung 14:30"],
    });
    expect(
      runLine(
        {
          run: { state: "running", next_check_at: null },
          playbook,
          now: NOW,
          zone: "UTC",
        },
        "en",
        en,
      ),
    ).toEqual({
      state: { label: "running", badge: "running" },
      facts: ["Now: Erinnerungen vorbereiten"],
    });
  });

  test("an ended run shows its state alone", () => {
    for (const state of ["completed", "aborted", "failed"] as const)
      expect(
        runLine(
          {
            run: { state, next_check_at: "2026-11-19T14:30:00Z" },
            playbook,
            now: NOW,
            zone: "UTC",
          },
          "de",
          de,
        ).facts,
      ).toEqual([]);
  });

  test("a state this build does not know leaves the badge out", () => {
    expect(
      runLine(
        {
          run: { state: "future" as "running", next_check_at: null },
          playbook: null,
          now: NOW,
        },
        "de",
        de,
      ),
    ).toEqual({ state: null, facts: [] });
  });

  test("the next check is a time today and a date with time on another day", () => {
    expect(runCheckLabel("de", "2026-11-19T14:30:00Z", NOW, "UTC")).toBe("14:30");
    expect(runCheckLabel("en", "2026-11-19T14:30:00Z", NOW, "UTC")?.replace(/\s/gu, " ")).toBe(
      "2:30 PM",
    );
    expect(runCheckLabel("de", "2026-11-20T07:00:00Z", NOW, "UTC")).toBe("20.11.26, 07:00");
    expect(runCheckLabel("de", "2026-11-19T23:30:00Z", NOW, "Europe/Berlin")).toBe(
      "20.11.26, 00:30",
    );
    for (const missing of [null, undefined, "", "soon"])
      expect(runCheckLabel("de", missing, NOW, "UTC")).toBeNull();
  });

  test("the run date follows the language", () => {
    expect(runDateLabel("de", "2026-11-19T08:00:00Z", "UTC")).toBe("19.11.");
    expect(runDateLabel("en", "2026-11-19T08:00:00Z", "UTC")).toBe("Nov 19");
    expect(de("chat.taskRun.runOf", { date: "19.11." })).toBe("Run vom 19.11.");
    expect(runDateLabel("de", "never")).toBeNull();
  });
});

describe("which plan the run line shows", () => {
  const fromChat = plan("in_progress", []);
  const fromEvent = plan("open", []);

  test("a plan refreshed by a run event wins over an older conversation read", () => {
    expect(newerPlaybook({ playbook: fromChat, at: 100 }, { playbook: fromEvent, at: 200 })).toBe(
      fromEvent,
    );
    expect(newerPlaybook({ playbook: fromChat, at: 100 }, { playbook: null, at: 200 })).toBeNull();
  });

  test("a newer conversation read wins, and so does it while nothing was refreshed", () => {
    expect(newerPlaybook({ playbook: fromChat, at: 300 }, { playbook: fromEvent, at: 200 })).toBe(
      fromChat,
    );
    expect(newerPlaybook({ playbook: fromChat, at: 100 }, { playbook: undefined, at: 0 })).toBe(
      fromChat,
    );
  });
});
