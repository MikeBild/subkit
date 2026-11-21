import { describe, expect, test } from "bun:test";
import { auditActionLabel } from "@/lib/audit-model";
import { CATALOGS, type TranslationKey, translate } from "@/lib/i18n";
import { run, task } from "./tasks-fixtures";
import {
  actionKey,
  badgeState,
  bothEnvironments,
  changesWork,
  displayState,
  draftFromTask,
  draftName,
  emptyDraft,
  failureKey,
  formPlan,
  hasSchedule,
  historyKey,
  historyTone,
  isOpenRun,
  isTaskFilter,
  matchesFilter,
  nameFromGoal,
  planForSave,
  resultErrorKey,
  type ScheduleDraft,
  saveErrorKey,
  saveWarning,
  startErrorKey,
  stateKey,
  stateTone,
  stateWords,
  summaryParts,
  TASK_RESULT_STEP_ID,
  TASK_RUN_STATES,
  type Task,
  type TaskRun,
  taskBody,
  taskCounts,
  taskStatus,
  triggerKey,
} from "./tasks-model";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const BERLIN = "Europe/Berlin";

const draft = (change: Partial<ScheduleDraft>): ScheduleDraft => ({
  option: "manual",
  time: "07:00",
  weekday: 1,
  runAt: "",
  cron: "",
  timezone: BERLIN,
  ...change,
});

describe("run state words", () => {
  test("every persisted run state has its own word in German and English", () => {
    const german = TASK_RUN_STATES.map((state) => translate("de", stateKey(state)));
    const english = TASK_RUN_STATES.map((state) => translate("en", stateKey(state)));
    expect(german).toEqual([
      "läuft",
      "wartet auf dich",
      "schläft",
      "Ergebnis liegt vor",
      "erledigt",
      "abgebrochen",
      "fehlgeschlagen",
    ]);
    expect(english).toEqual([
      "running",
      "waiting for you",
      "sleeping",
      "result ready",
      "done",
      "aborted",
      "failed",
    ]);
    expect(new Set(german).size).toBe(german.length);
    expect(new Set(english).size).toBe(english.length);
  });

  test("a sleeping run names the time it wakes up", () => {
    const words = {
      t: (key: Parameters<typeof translate>[1], values?: Record<string, string>) =>
        translate("de", key, values),
      time: () => "14:30",
    };
    expect(stateWords("sleeping", { next_check_at: "2026-11-19T13:30:00Z" }, words)).toBe(
      "schläft bis 14:30",
    );
    expect(stateWords("sleeping", { next_check_at: null }, words)).toBe("schläft");
    expect(stateWords("running", null, words)).toBe("läuft");
  });

  test("tones never rely on a state the badge does not know", () => {
    expect(stateTone("failed")).toBe("error");
    expect(stateTone("completed")).toBe("ok");
    expect(stateTone("waiting")).toBe("warn");
    expect(stateTone("result_ready")).toBe("info");
    expect(stateTone("sleeping")).toBe("neutral");
    expect(badgeState("info")).toBe("running");
    expect(badgeState("error")).toBe("error");
  });

  test("a task shows paused first, then its latest run, then its plan", () => {
    expect(displayState(task({ paused_at: "2026-11-01T00:00:00Z" }), run())).toBe("paused");
    expect(displayState(task(), run({ state: "sleeping" }))).toBe("sleeping");
    expect(displayState(task({ schedule_cron: "0 7 * * *" }), null)).toBe("scheduled");
    expect(displayState(task(), null)).toBe("ready");
    expect(isOpenRun(run({ state: "waiting" }))).toBe(true);
    expect(isOpenRun(run({ state: "result_ready" }))).toBe(false);
    expect(isOpenRun(null)).toBe(false);
  });
});

describe("the one recommended action", () => {
  const status = (
    taskChange: Partial<Task>,
    runChange: Partial<TaskRun> | null,
    grantLive: boolean | null = null,
  ) =>
    taskStatus({
      task: task(taskChange),
      run: runChange ? run(runChange) : null,
      grantLive,
    });

  test("each state carries exactly the action the product names", () => {
    expect(status({}, { state: "waiting", waiting_reason: "question" }).action).toBe("answer");
    expect(status({}, { state: "result_ready" }).action).toBe("review");
    expect(status({ schedule_cron: "0 7 * * *" }, null, false).action).toBe("allow");
    expect(status({ paused_at: "2026-11-01T00:00:00Z" }, { state: "waiting" }).action).toBe(
      "resume",
    );
    for (const state of ["running", "sleeping", "completed", "aborted", "failed"] as const)
      expect(status({}, { state }).action).toBeNull();
    expect(status({}, null).action).toBeNull();
    expect(status({ schedule_cron: "0 7 * * *" }, null, true).action).toBeNull();
  });

  test("the action words are the agreed ones", () => {
    const words = (locale: "de" | "en") =>
      (["answer", "review", "allow", "resume"] as const).map((action) =>
        translate(locale, actionKey(action)),
      );
    expect(words("de")).toEqual(["Antworten", "Ergebnis prüfen", "Erlauben", "Fortsetzen"]);
    expect(words("en")).toEqual(["Answer", "Review result", "Allow", "Resume"]);
  });

  test("a waiting run says why in one sentence per reason", () => {
    const lines = (
      ["question", "approval", "no_progress", "budget", "question_expired", "ai_access"] as const
    ).map((waiting_reason) => status({}, { state: "waiting", waiting_reason }).line);
    expect(new Set(lines).size).toBe(6);
    expect(status({}, { state: "waiting", waiting_reason: null }).line).toBe(
      "tasks.strip.waiting.question",
    );
  });

  test("kinds and tones follow the state", () => {
    expect(status({ paused_at: "x", paused_reason: "owner_unavailable" }, null).line).toBe(
      "tasks.strip.pausedOwner",
    );
    expect(status({}, { state: "failed" })).toMatchObject({ kind: "failed", tone: "error" });
    expect(status({}, { state: "running" }).kind).toBe("running");
    expect(status({}, { state: "sleeping" }).kind).toBe("sleeping");
    expect(status({}, { state: "completed" })).toMatchObject({ kind: "completed", tone: "ok" });
    expect(status({}, { state: "aborted" }).kind).toBe("aborted");
    expect(status({ schedule_cron: "0 7 * * *" }, { state: "completed" }, false).kind).toBe(
      "grant_required",
    );
    expect(status({ schedule_cron: "0 7 * * *" }, null, null).kind).toBe("scheduled");
    expect(status({}, null).kind).toBe("ready");
  });
});

describe("list filter and summary", () => {
  const rows = [
    { task: task({ id: "1" }), run: run({ state: "running" }) },
    { task: task({ id: "2" }), run: run({ state: "waiting" }) },
    { task: task({ id: "3", schedule_cron: "0 7 * * *" }), run: run({ state: "result_ready" }) },
    { task: task({ id: "4", schedule_cron: "0 7 * * *", paused_at: "x" }), run: null },
    { task: task({ id: "5" }), run: run({ state: "sleeping" }) },
    { task: task({ id: "6", schedule_run_at: "2026-12-01T08:00:00Z" }), run: null },
  ];

  test("the four filters select what their names say", () => {
    const ids = (filter: Parameters<typeof matchesFilter>[1]) =>
      rows.filter((row) => matchesFilter(row, filter)).map((row) => row.task.id);
    expect(ids("all")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(ids("waiting")).toEqual(["2", "3"]);
    expect(ids("scheduled")).toEqual(["3", "6"]);
    expect(ids("paused")).toEqual(["4"]);
    expect(isTaskFilter("paused")).toBe(true);
    expect(isTaskFilter("else")).toBe(false);
  });

  test("the summary counts working, waiting and scheduled tasks and drops empty parts", () => {
    const counts = taskCounts(rows);
    expect(counts).toEqual({ total: 6, working: 2, waiting: 2, ai: 0, scheduled: 2 });
    expect(summaryParts(counts).map((part) => part.key)).toEqual([
      "tasks.summary.working",
      "tasks.summary.waiting",
      "tasks.summary.scheduled",
    ]);
    expect(summaryParts({ total: 3, working: 0, waiting: 0, ai: 0, scheduled: 0 })).toEqual([
      { key: "tasks.summary.total", count: 3 },
    ]);
    expect(summaryParts({ total: 3, working: 0, waiting: 1, ai: 0, scheduled: 0 })).toEqual([
      { key: "tasks.summary.waiting", count: 1 },
    ]);
  });

  test("a one-time start counts as scheduled only until it was claimed", () => {
    expect(hasSchedule(task({ schedule_run_at: "2026-12-01T08:00:00Z" }))).toBe(true);
    expect(
      hasSchedule(
        task({ schedule_run_at: "2026-11-01T08:00:00Z", last_claimed_at: "2026-11-01T08:00:01Z" }),
      ),
    ).toBe(false);
    expect(hasSchedule(task())).toBe(false);
  });
});

describe("the form", () => {
  const filled = () =>
    emptyDraft(BERLIN, {
      goal: "Offene Rechnungen nachfassen. Bis alle bezahlt sind.",
      doneWhen: "Alle Rechnungen sind bezahlt.",
    });

  test("three answers are enough for a valid task", () => {
    const built = taskBody(filled(), null, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toMatchObject({
      name: "Offene Rechnungen nachfassen",
      description: null,
      goal: "Offene Rechnungen nachfassen. Bis alle bezahlt sind.",
      done_when: "Alle Rechnungen sind bezahlt.",
      environment: "prod",
      schedule_cron: null,
      schedule_run_at: null,
      max_turns: 10,
      run_deadline_minutes: 240,
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
    });
    expect(built.body.plan.steps.map((step) => step.id)).toEqual(["work"]);
    expect(built.body.plan.completion_step_id).toBeNull();
    expect("category" in built.body).toBe(false);
  });

  test("missing answers name the field to fill", () => {
    const issue = (change: Partial<ReturnType<typeof filled>>) => {
      const built = taskBody({ ...filled(), ...change }, null, NOW);
      return built.ok ? null : built.issue;
    };
    expect(issue({ goal: " " })).toBe("tasks.form.error.goal");
    expect(issue({ doneWhen: "" })).toBe("tasks.form.error.doneWhen");
    expect(issue({ goal: "..." })).toBe("tasks.form.error.name");
    expect(issue({ schedule: draft({ option: "once" }) })).toBe("tasks.schedule.error.runAt");
  });

  test("the name follows the goal until a person types one", () => {
    expect(nameFromGoal("Preise prüfen und melden!\nMehr Text")).toBe("Preise prüfen und melden");
    const long = nameFromGoal(`${"Wort ".repeat(30)}Ende`);
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith("…")).toBe(true);
    expect(nameFromGoal("x".repeat(120))).toBe(`${"x".repeat(80)}…`);
    expect(draftName({ name: " Mein Name ", nameEdited: true, goal: "Ziel." })).toBe("Mein Name");
    expect(draftName({ name: " ", nameEdited: true, goal: "Ziel." })).toBe("Ziel");
  });

  test("an existing task opens with its values and saves unchanged without ending anything", () => {
    const stored = task({
      name: "Rechnungen",
      goal: "Rechnungen nachfassen",
      done_when: "Alles bezahlt",
      category: "billing",
      description: "Beschreibung",
      plan: formPlan("Rechnungen", "Rechnungen nachfassen", "Alles bezahlt"),
      schedule_cron: "0 7 * * *",
      schedule_timezone: BERLIN,
      max_turns: 35,
    });
    const opened = draftFromTask(stored, "UTC");
    expect(opened).toMatchObject({ name: "Rechnungen", nameEdited: true, maxTurns: 35 });
    expect(opened.schedule).toMatchObject({ option: "daily", timezone: BERLIN });
    const built = taskBody(opened, stored, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.category).toBe("billing");
    expect(built.body.description).toBe("Beschreibung");
    expect(changesWork(stored, built.body)).toBe(false);
    const renamed = taskBody({ ...opened, name: "Neuer Name" }, stored, NOW);
    expect(renamed.ok && changesWork(stored, renamed.body)).toBe(false);
  });

  test("every change of work, schedule or limits is recognized", () => {
    const stored = task({
      plan: formPlan("T", "Ziel", "Fertig"),
      goal: "Ziel",
      done_when: "Fertig",
    });
    const opened = draftFromTask(stored, BERLIN);
    const changed = (change: Partial<typeof opened>) => {
      const built = taskBody({ ...opened, ...change }, stored, NOW);
      return built.ok && changesWork(stored, built.body);
    };
    expect(changed({})).toBe(false);
    expect(changed({ goal: "Anderes Ziel" })).toBe(true);
    expect(changed({ doneWhen: "Anders fertig" })).toBe(true);
    expect(changed({ workflowIds: ["w"] })).toBe(true);
    expect(changed({ connectorIds: ["c"] })).toBe(true);
    expect(changed({ skillSlugs: ["s"] })).toBe(true);
    expect(changed({ webSearch: true })).toBe(true);
    expect(changed({ environment: "dev" })).toBe(true);
    expect(changed({ schedule: draft({ option: "daily" }) })).toBe(true);
    expect(changed({ schedule: draft({ option: "once", runAt: "2026-12-01T08:00" }) })).toBe(true);
    expect(changed({ maxTurns: 50 })).toBe(true);
    expect(changed({ deadlineMinutes: 60 })).toBe(true);
  });

  test("key order of a stored plan and the spelling of an instant do not count as a change", () => {
    const plan = formPlan("T", "Ziel", "Fertig");
    const reordered = JSON.parse(
      JSON.stringify({
        steps: plan.steps,
        goal: plan.goal,
        title: plan.title,
        completion_step_id: null,
        cancelled: false,
      }),
    );
    const stored = task({
      plan: reordered,
      goal: "Ziel",
      done_when: "Fertig",
      schedule_run_at: "2026-12-01T07:00:00+00:00",
      schedule_timezone: BERLIN,
    });
    const built = taskBody(draftFromTask(stored, BERLIN), stored, NOW);
    expect(built.ok && changesWork(stored, built.body)).toBe(false);
  });

  test("a plan made in chat is kept, and only a new goal rebuilds its frame", () => {
    const chat = {
      title: "Plan",
      goal: "Ziel",
      steps: [
        { ...formPlan("x", "a", "b").steps[0]!, id: "find", label: "Finden" },
        {
          ...formPlan("x", "a", "b").steps[0]!,
          id: "remind",
          label: "Erinnern",
          depends_on: ["find", TASK_RESULT_STEP_ID],
        },
        {
          ...formPlan("x", "a", "b").steps[0]!,
          id: TASK_RESULT_STEP_ID,
          label: "Ziel",
          criterion: { kind: "human_confirmation" as const, question: "Ziel" },
        },
      ],
      cancelled: false,
      completion_step_id: TASK_RESULT_STEP_ID,
    };
    expect(planForSave(chat, "Name", "Ziel", "Fertig")).toBe(chat);
    const rebuilt = planForSave(chat, "Name", "Neues Ziel", "Fertig");
    expect(rebuilt.goal).toBe("Neues Ziel");
    expect(rebuilt.title).toBe("Plan");
    expect(rebuilt.steps.map((step) => step.id)).toEqual(["find", "remind"]);
    expect(rebuilt.steps[1]?.depends_on).toEqual(["find"]);
    expect(rebuilt.completion_step_id).toBeNull();
    expect(
      planForSave({ ...chat, completion_step_id: "remind" }, "N", "Neu", "F").completion_step_id,
    ).toBe("remind");
    expect(planForSave({ ...chat, cancelled: true }, "N", "Ziel", "F").steps[0]?.id).toBe("work");
    expect(planForSave({ ...chat, steps: [chat.steps[2]!] }, "N", "Ziel", "F").title).toBe("Plan");
    expect(planForSave(null, "N", "Ziel", "F").title).toBe("N");
    const form = formPlan("T", "Ziel", "Fertig");
    expect(planForSave(form, "N", "Ziel", "Fertig")).toBe(form);
    expect(planForSave(form, "N", "Ziel", "Anders").title).toBe("T");
    expect(formPlan("T", "z".repeat(700), "f").goal.length).toBe(600);
  });

  test("saving warns only when work changes and something would end", () => {
    expect(saveWarning(false, true, true)).toBeNull();
    expect(saveWarning(true, false, false)).toBeNull();
    expect(saveWarning(true, true, true)).toBe("tasks.form.warn.both");
    expect(saveWarning(true, true, false)).toBe("tasks.form.warn.run");
    expect(saveWarning(true, false, true)).toBe("tasks.form.warn.grant");
  });

  test("refusals are translated into the next step", () => {
    expect(saveErrorKey("task_revision_conflict")).toBe("tasks.form.error.conflict");
    expect(translate("de", "tasks.form.error.conflict")).toContain("Lade die Seite neu");
    expect(translate("en", "tasks.form.error.conflict")).toContain("Reload the page");
    expect(saveErrorKey("cron_too_frequent")).toBe("tasks.schedule.error.tooFrequent");
    expect(saveErrorKey("run_at_past")).toBe("tasks.schedule.error.runAtPast");
    expect(saveErrorKey("plan_cancelled")).toBe("tasks.form.error.save");
    expect(saveErrorKey(null)).toBe("tasks.form.error.save");
    expect(startErrorKey("previous_run_active")).toBe("tasks.start.error.active");
    expect(startErrorKey("paused")).toBe("tasks.start.error.paused");
    expect(startErrorKey("internal_error")).toBe("tasks.start.error.other");
    expect(startErrorKey(undefined)).toBe("tasks.start.error.other");
    expect(resultErrorKey("playbook_tampered")).toBe("tasks.review.error.tampered");
    expect(resultErrorKey("task_run_not_result_ready")).toBe("tasks.review.error.changed");
    expect(resultErrorKey("task_run_reopen_blocked")).toBe("tasks.review.error.reopen");
    expect(resultErrorKey("human_session_required")).toBe("tasks.review.error.session");
    expect(resultErrorKey(null)).toBe("tasks.review.error.other");
  });

  test("Test and Live are offered only when the workspace has both", () => {
    expect(bothEnvironments([{ environment: "prod" }], null)).toBe(false);
    expect(bothEnvironments([{ environment: "prod" }, { environment: "dev" }], null)).toBe(true);
    expect(bothEnvironments([{ environment: "prod" }], "dev")).toBe(true);
    expect(bothEnvironments([], "prod")).toBe(false);
  });
});

describe("overview, runs and history words", () => {
  test("every audit action of a task has a label and unknown ones a neutral word", () => {
    const actions = [
      "task.created",
      "task.updated",
      "task.deleted",
      "task.paused",
      "task.resumed",
      "task.authority_granted",
      "task.authority_revoked",
      "task.admission.changed",
      "task.schedule_claimed",
      "task_run.started",
      "task_run.waiting",
      "task_run.resumed",
      "task_run.result_ready",
      "task_run.completed",
      "task_run.failed",
      "task_run.abort_requested",
      "task_run.aborted",
    ];
    for (const action of actions) {
      const label = auditActionLabel(action);
      expect(label.kind).toBe("named");
      expect(historyKey(action)).toBe(label.kind === "named" ? label.key : "tasks.history.other");
    }
    const labels = actions.map((action) => translate("de", historyKey(action)));
    expect(new Set(labels).size).toBe(17);
    expect(labels).not.toContain(translate("de", "tasks.history.other"));
    expect(historyKey("task.future")).toBe("tasks.history.other");
    expect(historyTone("task_run.failed", "success")).toBe("error");
    expect(historyTone("task.updated", "error")).toBe("error");
    expect(historyTone("task.admission.changed", "denied")).toBe("warn");
    expect(historyTone("task_run.waiting", "success")).toBe("warn");
    expect(historyTone("task_run.completed", "success")).toBe("ok");
    expect(historyTone("task.created", "success")).toBe("neutral");
  });

  test("triggers and failure codes read as plain words", () => {
    expect(
      (["manual", "once", "cron"] as const).map((trigger) => translate("de", triggerKey(trigger))),
    ).toEqual(["von Hand", "einmalig geplant", "nach Zeitplan"]);
    expect(failureKey(null)).toBeNull();
    expect(failureKey("deadline_exceeded")).toBe("tasks.failure.deadline_exceeded");
    const failures = Object.keys(CATALOGS.en).filter((key) => key.startsWith("tasks.failure."));
    expect(failures.filter((key) => key !== "tasks.failure.unknown")).toHaveLength(12);
    expect(translate("de", failureKey("turn_limit_reached") as TranslationKey)).toBe(
      "Der Run hat alle Runden verbraucht, ohne ein Ergebnis zu liefern.",
    );
  });
});

describe("task copy", () => {
  const keys = Object.keys(CATALOGS.en).filter(
    (key) => key.startsWith("tasks.") || key === "nav.tasks",
  ) as (keyof typeof CATALOGS.en)[];
  const technical = (key: string) =>
    key.startsWith("tasks.technical.") ||
    key.startsWith("tasks.run.technical.") ||
    key.startsWith("tasks.schedule.cron") ||
    key === "tasks.schedule.error.cron";

  test("no exclamation marks, and the words the product never shows stay in technical details", () => {
    const banned =
      /\b(dev|prod|environment|Umgebung|cron|fingerprint|grant|boundary|tenant|principal|turns?)\b/i;
    for (const key of keys) {
      for (const locale of ["de", "en"] as const) {
        const text = CATALOGS[locale][key];
        expect(text, key).not.toContain("!");
        if (!technical(key)) expect(text, `${locale} ${key}`).not.toMatch(banned);
      }
    }
  });

  test("German uses German quotation marks and du, English uses curly quotes", () => {
    for (const key of keys) {
      expect(CATALOGS.de[key], key).not.toMatch(/"|”|\bIhnen\b|\bIhre[mnrs]?\b/);
      expect(CATALOGS.en[key], key).not.toMatch(/"|„/);
    }
  });
});
