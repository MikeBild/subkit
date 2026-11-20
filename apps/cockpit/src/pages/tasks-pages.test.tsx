import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderInRouter } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import { TaskDetail, TaskPage } from "./tasks-detail";
import { CONVERSATION_ID, latestRun, run, TASK_ID, task, usagePeriod } from "./tasks-fixtures";
import { TaskFormFields, TaskScheduleFields } from "./tasks-form";
import { TasksPage } from "./tasks-list";
import {
  emptyDraft,
  scheduleDraft,
  type TaskRun,
  type TaskUsage,
  type TaskView,
} from "./tasks-model";
import { TaskRunsTab } from "./tasks-runs";

const ALL = [
  "task:read",
  "task:write",
  "task:run",
  "task:delete",
  "task:pause",
  "task:resume",
  "task:grant",
  "task_run:read",
  "task_run:abort",
  "conversation:read",
  "conversation:write",
  "audit:read",
  "workflow:read",
  "connector:read",
];

const without = (...gone: string[]) => ALL.filter((permission) => !gone.includes(permission));

function cache(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
}

function show(element: ReactElement, client: QueryClient, locale: "de" | "en" = "de") {
  return renderInRouter(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    locale,
  );
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;
const has = (markup: string, testId: string) => markup.includes(`data-testid="${testId}"`);

function listed(rows: { task: TaskView; run: TaskRun | null }[], total = rows.length): QueryClient {
  const client = cache();
  client.setQueryData(["tasks", "list", ""], {
    items: rows.map((row) => ({ ...row.task, latest_run: latestRun(row.run) })),
    total,
  });
  return client;
}

describe("task list", () => {
  const rows = [
    { task: task(), run: run({ state: "waiting", waiting_reason: "question" }) },
    {
      task: task({ id: "t-2", name: "Wochenzahlen", schedule_cron: "0 8 * * 1" }),
      run: run({ state: "running" }),
    },
    {
      task: task({ id: "t-3", name: "Preise beobachten", schedule_cron: "0 7 * * *" }),
      run: run({ state: "sleeping", next_check_at: "2026-11-19T13:30:00Z" }),
    },
    { task: task({ id: "t-4", name: "Angebot vorbereiten" }), run: run({ state: "result_ready" }) },
  ];

  test("shows one summary sentence, one primary action and one row per task that links its page", async () => {
    const markup = await show(<TasksPage permissions={ALL} />, listed(rows));
    expect(count(markup, "<h1")).toBe(1);
    expect(markup).toContain("2 laufen");
    expect(markup).toContain("2 warten auf dich");
    expect(markup).toContain("2 geplant");
    expect(count(markup, 'data-testid="tasks-new"')).toBe(1);
    expect(has(markup, "tasks-summary-help")).toBe(true);
    for (const index of [0, 1, 2, 3]) expect(has(markup, `tasks-row-link-${index}`)).toBe(true);
    expect(markup).toContain(`/tasks/${TASK_ID}"`);
    for (const words of [
      "wartet auf dich",
      "läuft",
      "schläft bis 2026-11-19T13:30:00Z",
      "Ergebnis liegt vor",
      "von Hand",
      "täglich um 07:00",
    ])
      expect(markup).toContain(words);
    expect(markup).not.toContain(TASK_ID.concat("<"));
  });

  test("offers the four filters once and applies the chosen one", async () => {
    const markup = await show(<TasksPage permissions={ALL} />, listed(rows));
    for (const filter of ["all", "waiting", "scheduled", "paused"])
      expect(has(markup, `tasks-filter-${filter}`)).toBe(true);
    for (const label of ["Alle", "Wartet auf mich", "Geplant", "Pausiert"])
      expect(markup).toContain(label);
  });

  test("speaks English with the same structure", async () => {
    const markup = await show(<TasksPage permissions={ALL} />, listed(rows), "en");
    for (const words of ["Tasks", "New task", "2 running", "2 waiting for you", "result ready"])
      expect(markup).toContain(words);
    expect(markup).not.toContain("Aufgabe");
  });

  test("an empty workspace gets three examples and still exactly one way to start blank", async () => {
    const markup = await show(<TasksPage permissions={ALL} />, listed([]));
    expect(has(markup, "tasks-onboarding")).toBe(true);
    for (const template of ["invoices", "numbers", "prices"])
      expect(has(markup, `tasks-template-${template}`)).toBe(true);
    expect(count(markup, 'data-testid="tasks-new"')).toBe(1);
    expect(has(markup, "tasks-filter")).toBe(false);
    const reader = await show(<TasksPage permissions={["task:read"]} />, listed([]));
    expect(has(reader, "tasks-onboarding")).toBe(true);
    expect(has(reader, "tasks-template-invoices")).toBe(false);
    expect(has(reader, "tasks-new")).toBe(false);
  });

  test("shows a skeleton while loading and a retry when loading failed", async () => {
    const loading = await show(<TasksPage permissions={ALL} />, cache());
    expect(has(loading, "tasks-skeleton-row-0")).toBe(true);
    expect(has(loading, "tasks-onboarding")).toBe(false);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    await client.prefetchQuery({
      queryKey: ["tasks", "list", ""],
      queryFn: () => Promise.reject(new Error("offline")),
    });
    const failed = await show(<TasksPage permissions={ALL} />, client);
    expect(has(failed, "tasks-error")).toBe(true);
    expect(has(failed, "tasks-retry")).toBe(true);
    expect(failed).toContain(translate("de", "session.retry"));
    expect(has(failed, "tasks-onboarding")).toBe(false);
  });

  test("a start that is due but held shows one phrase in the row instead of a date", async () => {
    const markup = await show(
      <TasksPage permissions={ALL} />,
      listed([
        {
          task: task({ schedule_cron: "0 7 * * *", next_start_at: "2020-01-01T07:00:00Z" }),
          run: null,
        },
      ]),
    );
    expect(markup).toContain("fällig, wartet auf Erlaubnis");
    expect(markup).not.toContain("2020-01-01");
  });

  test("has no cap notice and never loads without the read permission", async () => {
    const all = await show(<TasksPage permissions={ALL} />, listed(rows, 140));
    expect(all).not.toContain("zuletzt geänderten");
    const client = cache();
    const denied = await show(<TasksPage permissions={[]} />, client);
    expect(has(denied, "resource-permission-alert")).toBe(true);
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.fetchStatus === "idle"),
    ).toBe(true);
  });
});

describe("task detail", () => {
  function detail(
    taskChange: Partial<TaskView>,
    latest: TaskRun | null,
    options: {
      permissions?: string[];
      question?: string | null;
      usage?: TaskUsage;
      locale?: "de" | "en";
    } = {},
  ) {
    const client = cache();
    const current = task({ latest_run: latestRun(latest), ...taskChange });
    client.setQueryData(["task-runs", TASK_ID, "list"], {
      items: latest ? [latest] : [],
      total: latest ? 1 : 0,
    });
    if (latest && options.question !== undefined)
      client.setQueryData(["task-run", latest.id], {
        ...latest,
        pending_question: options.question,
      });
    if (options.usage) client.setQueryData(["task-usage", TASK_ID], options.usage);
    return show(
      <TaskDetail task={current} permissions={options.permissions ?? ALL} />,
      client,
      options.locale,
    );
  }
  const strip = (markup: string) =>
    ["answer", "review", "allow", "resume", "view"].filter((action) =>
      has(markup, `task-strip-${action}`),
    );

  test("the status strip carries exactly the one action of each state", async () => {
    const waiting = await detail({}, run({ state: "waiting", waiting_reason: "question" }));
    expect(strip(waiting)).toEqual(["answer"]);
    expect(waiting).toContain(`/chat/${CONVERSATION_ID}"`);
    expect(waiting).toContain("Der Lauf wartet auf deine Antwort.");
    expect(strip(await detail({}, run({ state: "result_ready" })))).toEqual(["review"]);
    expect(strip(await detail({}, run({ state: "failed", failure_code: "turn_failed" })))).toEqual([
      "view",
    ]);
    expect(
      strip(
        await detail({ paused_at: "2026-11-01T00:00:00Z", paused_reason: "owner_request" }, null),
      ),
    ).toEqual(["resume"]);
    expect(strip(await detail({ schedule_cron: "0 7 * * *", grant_live: false }, null))).toEqual([
      "allow",
    ]);
    expect(strip(await detail({ schedule_cron: "0 7 * * *", grant_live: true }, null))).toEqual([]);
    for (const state of ["running", "sleeping", "completed", "aborted"] as const)
      expect(strip(await detail({}, run({ state })))).toEqual([]);
    expect(strip(await detail({}, null))).toEqual([]);
  });

  test("a run ended at its round limit offers a new start and its conversation, never to continue", async () => {
    const ended = run({ state: "failed", failure_code: "turn_limit_reached" });
    const markup = await detail({}, ended);
    expect([...strip(markup), ...(has(markup, "task-strip-restart") ? ["restart"] : [])]).toEqual([
      "restart",
    ]);
    expect(markup).toContain("Der Lauf hat sein Rundenlimit erreicht und wurde beendet.");
    expect(count(markup, ">Neu starten<")).toBe(1);
    expect(markup).not.toContain(">Fortsetzen<");
    expect(has(markup, "task-strip-conversation")).toBe(true);
    expect(markup).toContain(`/chat/${CONVERSATION_ID}"`);
    const english = await detail({}, ended, { locale: "en" });
    expect(english).toContain("The run reached its round limit and has ended.");
    expect(count(english, ">Start again<")).toBe(1);
    expect(
      has(
        await detail({}, ended, { permissions: without("conversation:read") }),
        "task-strip-conversation",
      ),
    ).toBe(false);
  });

  test("every action exists once: start in the header, the rest in the menu or the strip", async () => {
    const markup = await detail({}, run({ state: "waiting", waiting_reason: "question" }));
    expect(count(markup, "<h1")).toBe(1);
    expect(count(markup, 'data-testid="task-start"')).toBe(1);
    expect(count(markup, 'data-testid="task-menu"')).toBe(1);
    expect(count(markup, 'data-slot="status-strip-action"')).toBe(1);
    expect(count(markup, ">Antworten<")).toBe(1);
    expect(count(markup, ">Starten<")).toBe(1);
    expect(has(markup, "detail-back")).toBe(true);
  });

  test("start is unavailable, with a reason, while a run is open or the task is paused", async () => {
    expect(has(await detail({}, run({ state: "running" })), "task-start-blocked")).toBe(true);
    expect(
      has(await detail({ paused_at: "2026-11-01T00:00:00Z" }, null), "task-start-blocked"),
    ).toBe(true);
    expect(has(await detail({}, run({ state: "completed" })), "task-start-blocked")).toBe(false);
    expect(
      has(await detail({}, null, { permissions: without("task:run") }), "task-start-blocked"),
    ).toBe(true);
  });

  test("tabs follow the agreed order and hide what the person may not read", async () => {
    const markup = await detail({}, null);
    const order = ["overview", "runs", "schedule", "permissions", "history"].map((tab) =>
      markup.indexOf(`data-testid="detail-tasks-tabs-tab-${tab}"`),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const label of ["Überblick", "Läufe", "Zeitplan", "Darf", "Verlauf"])
      expect(markup).toContain(label);
    const reader = await detail({}, null, { permissions: ["task:read"] });
    expect(has(reader, "detail-tasks-tabs-tab-runs")).toBe(false);
    expect(has(reader, "detail-tasks-tabs-tab-history")).toBe(false);
    expect(has(reader, "task-menu")).toBe(false);
  });

  test("the overview is plain: goal, three tiles, done-when and steps, technical data collapsed", async () => {
    const markup = await detail(
      {},
      run({
        state: "sleeping",
        next_check_at: "2026-11-19T13:30:00Z",
        sleep_reason: "Zahlungseingang",
      }),
    );
    expect(markup).toContain("Fasst offene Rechnungen nach, bis sie bezahlt sind.");
    for (const tile of ["now", "waiting", "next", "usage"])
      expect(has(markup, `task-tile-${tile}`)).toBe(true);
    for (const words of [
      "Jetzt",
      "Wartet auf",
      "Zahlungseingang",
      "Nächste Prüfung",
      "2026-11-19T13:30:00Z",
      "Fertig, wenn",
      "Schritte",
      "Ergebnis bestätigen",
    ])
      expect(markup).toContain(words);
    expect(has(markup, "detail-tasks-technical-toggle")).toBe(true);
    expect(markup).not.toContain("a".repeat(64));
    expect(markup).not.toContain(TASK_ID);
    expect(markup).not.toMatch(/>prod</);
  });

  test("a waiting run quotes its open question in the viewer's quotation marks", async () => {
    const waiting = run({ state: "waiting", waiting_reason: "question" });
    const asked = await detail({}, waiting, { question: "Darf ich Lena die Erinnerung schicken?" });
    expect(asked).toContain("Wartet auf dich: „Darf ich Lena die Erinnerung schicken?“");
    expect(asked).not.toContain("Der Lauf wartet auf deine Antwort.");
    expect(strip(asked)).toEqual(["answer"]);
    expect(
      await detail({}, waiting, { question: "May I send Lena the reminder?", locale: "en" }),
    ).toContain("Waiting for you: “May I send Lena the reminder?”");
    expect(await detail({}, waiting, { question: null })).toContain(
      "Der Lauf wartet auf deine Antwort.",
    );
  });

  test("a start that is due but held reads as one phrase, never as a past date", async () => {
    const held = await detail(
      { schedule_cron: "0 7 * * *", next_start_at: "2020-01-01T07:00:00Z", grant_live: false },
      null,
    );
    expect(held).toContain("fällig, wartet auf Erlaubnis");
    expect(held).not.toContain("2020-01-01T07:00:00Z");
    expect(strip(held)).toEqual(["allow"]);
    const planned = await detail(
      { schedule_cron: "0 7 * * *", next_start_at: "2999-01-01T07:00:00Z", grant_live: true },
      null,
    );
    expect(planned).toContain("2999-01-01T07:00:00Z");
    expect(planned).not.toContain("fällig");
  });

  test("the usage tile shows the last run and the month, with gaps said plainly", async () => {
    const month = usagePeriod({ period: "current_month", task_run_id: null });
    const priced = await detail({}, null, {
      usage: {
        last_run: usagePeriod(),
        current_month: {
          ...month,
          cost: { amount: 3.5, currency: "USD", unpriced_models: ["local-model"] },
        },
      },
    });
    expect(priced).toContain("Verbrauch");
    expect(priced).toContain("Letzter Lauf: 0,42");
    expect(priced).toContain("Dieser Monat: mind. 3,50");
    expect(has(priced, "task-usage-help")).toBe(true);
    const gaps = await detail({}, null, {
      usage: {
        last_run: usagePeriod({ attribution: "conversation_removed", calls: 0, cost: null }),
        current_month: { ...month, cost: null },
      },
    });
    expect(gaps).toContain("Letzter Lauf: nicht mehr zuordenbar");
    expect(gaps).toContain("Dieser Monat: 12.500 Token");
    const idle = await detail({}, null, {
      usage: {
        last_run: usagePeriod({ task_run_id: null, calls: 0, tokens: 0, cost: null }),
        current_month: { ...month, calls: 0, tokens: 0, cost: null },
      },
      locale: "en",
    });
    expect(idle).toContain("Last run: nothing yet");
    expect(idle).toContain("This month: nothing yet");
  });

  test("actions a person may not take are not offered", async () => {
    expect(
      strip(await detail({}, run({ state: "result_ready" }), { permissions: without("task:run") })),
    ).toEqual([]);
    expect(
      strip(
        await detail({ schedule_cron: "0 7 * * *" }, null, {
          permissions: without("task:grant"),
        }),
      ),
    ).toEqual([]);
    expect(
      strip(
        await detail({}, run({ state: "waiting" }), { permissions: without("conversation:read") }),
      ),
    ).toEqual([]);
    expect(
      strip(
        await detail({ paused_at: "2026-11-01T00:00:00Z" }, null, {
          permissions: without("task:resume"),
        }),
      ),
    ).toEqual([]);
  });

  test("speaks English with the same structure", async () => {
    const markup = await detail({}, run({ state: "result_ready" }), { locale: "en" });
    for (const words of [
      "Review result",
      "Start",
      "Overview",
      "Runs",
      "Schedule",
      "Permissions",
      "History",
      "Done when",
    ])
      expect(markup).toContain(words);
  });

  test("the page shows a boundary without the read permission and a skeleton while loading", async () => {
    const client = cache();
    const denied = await show(<TaskPage permissions={[]} />, client);
    expect(has(denied, "resource-permission-alert")).toBe(true);
    const loading = await show(<TaskPage permissions={ALL} />, cache());
    expect(has(loading, "detail-tasks-loading")).toBe(true);
  });
});

describe("task runs tab", () => {
  const tab = (runs: TaskRun[], state: { pending?: boolean; failed?: boolean } = {}) =>
    show(
      <TaskRunsTab
        runs={runs}
        total={runs.length}
        pending={Boolean(state.pending)}
        failed={Boolean(state.failed)}
        onRetry={() => {}}
        onOpen={() => {}}
      />,
      cache(),
    );

  test("lists runs in one table whose rows open the run", async () => {
    const markup = await tab([
      run({ state: "completed", ended_at: "2026-11-19T09:45:00.000Z", trigger: "cron" }),
      run({ id: "r-2", state: "failed", failure_code: "deadline_exceeded" }),
    ]);
    expect(markup).toContain("2 Läufe");
    for (const words of ["erledigt", "fehlgeschlagen", "nach Zeitplan", "von Hand"])
      expect(markup).toContain(words);
    expect(has(markup, "task-runs-row-0")).toBe(true);
    expect(markup).toContain("Lauf vom 2026-11-19T09:00:00.000Z öffnen");
  });

  test("has an empty, a loading and an error state", async () => {
    expect(await tab([])).toContain("Noch kein Lauf.");
    expect(has(await tab([], { pending: true }), "task-runs-skeleton-row-0")).toBe(true);
    const failed = await tab([], { failed: true });
    expect(failed).toContain("Die Läufe konnten nicht geladen werden.");
    expect(failed).toContain(translate("de", "session.retry"));
  });
});

describe("task form", () => {
  const fields = (choosesEnvironment = false) =>
    show(
      <TaskFormFields
        draft={emptyDraft("Europe/Berlin")}
        onChange={() => {}}
        workflowOptions={[{ value: "w1", label: "Zahlungsabgleich" }]}
        connectorOptions={[{ value: "c1", label: "Buchhaltung" }]}
        choosesEnvironment={choosesEnvironment}
      />,
      cache(),
    );

  test("asks three things first and keeps everything else collapsed", async () => {
    const markup = await fields();
    const order = ["task-form-goal", "task-form-done-when", "task-form-use", "task-form-more"].map(
      (id) => markup.indexOf(`data-testid="${id}"`),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const words of [
      "Was soll erledigt werden?",
      "Woran erkennst du, dass es fertig ist?",
      "Womit darf gearbeitet werden?",
      "Zahlungsabgleich",
      "Buchhaltung",
      "Weitere Einstellungen",
    ])
      expect(markup).toContain(words);
    for (const hidden of ["task-form-name", "task-schedule-option", "task-form-deadline"])
      expect(has(markup, hidden)).toBe(false);
    expect(markup).not.toContain('<textarea id="task-form-plan"');
  });

  test("the schedule is a choice, and the cron expression only shows under the own rhythm", async () => {
    const schedule = (change: Parameters<typeof scheduleDraft>[0], option?: string) =>
      show(
        <TaskScheduleFields
          value={{
            ...scheduleDraft(change, "Europe/Berlin"),
            ...(option ? { option: option as "once" } : {}),
          }}
          onChange={() => {}}
        />,
        cache(),
      );
    const manual = await schedule(null);
    for (const option of ["manual", "once", "daily", "weekdays", "weekly", "custom"])
      expect(has(manual, `task-schedule-option-${option}`)).toBe(true);
    for (const label of [
      "Nur von Hand",
      "Einmal am …",
      "Täglich",
      "Werktags",
      "Wöchentlich",
      "Eigener Rhythmus",
    ])
      expect(manual).toContain(label);
    expect(manual).toContain("Die Aufgabe startet nur, wenn du sie startest.");
    expect(has(manual, "task-schedule-cron")).toBe(false);
    expect(has(manual, "task-schedule-zone")).toBe(false);

    const daily = await schedule({
      schedule_cron: "0 7 * * *",
      schedule_timezone: "Europe/Berlin",
      schedule_run_at: null,
    });
    expect(has(daily, "task-schedule-time")).toBe(true);
    expect(has(daily, "task-schedule-zone")).toBe(true);
    expect(has(daily, "task-schedule-cron")).toBe(false);
    expect(daily).toContain("Nächster Start: ");

    const weekly = await schedule({
      schedule_cron: "0 7 * * 2",
      schedule_timezone: "Europe/Berlin",
      schedule_run_at: null,
    });
    expect(has(weekly, "task-schedule-weekday")).toBe(true);

    const once = await schedule(null, "once");
    expect(has(once, "task-schedule-run-at")).toBe(true);
    expect(has(once, "task-schedule-time")).toBe(false);

    const custom = await schedule({
      schedule_cron: "*/30 * * * *",
      schedule_timezone: "Europe/Berlin",
      schedule_run_at: null,
    });
    expect(has(custom, "task-schedule-cron")).toBe(true);
    expect(custom).toContain("Startet alle 30 Minuten.");
  });
});
