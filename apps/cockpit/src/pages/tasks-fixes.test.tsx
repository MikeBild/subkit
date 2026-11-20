import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { UiMessage } from "@/api/client";
import { CheckListField, checkListMatches } from "@/components/cockpit/form-field";
import { KpiTile, SegmentedControl } from "@/components/cockpit/patterns";
import { DIALOG_BODY } from "@/components/cockpit/patterns/dialog-frame";
import { render, renderInRouter } from "@/components/cockpit/patterns/test-utils";
import { ChatMessage } from "@/features/chat/message";
import { fromSetup } from "./tasks-default-environment";
import { TaskDetail } from "./tasks-detail";
import { CONVERSATION_ID, latestRun, run, TASK_ID, task } from "./tasks-fixtures";
import { TaskFormFields, TaskScheduleFields } from "./tasks-form";
import { emptyDraft, scheduleDraft, type TaskRun } from "./tasks-model";

const ALL = [
  "task:read",
  "task:write",
  "task:run",
  "task:grant",
  "task_run:read",
  "task_run:abort",
  "conversation:read",
  "audit:read",
  "stats:read",
];

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

const has = (markup: string, testId: string) => markup.includes(`data-testid="${testId}"`);
const count = (markup: string, needle: string) => markup.split(needle).length - 1;
const slice = (markup: string, testId: string, length = 700) => {
  const at = markup.indexOf(`data-testid="${testId}"`);
  return at < 0 ? "" : markup.slice(at, at + length);
};

function detail(
  latest: TaskRun | null,
  options: { permissions?: string[]; steps?: unknown[]; locale?: "de" | "en" } = {},
) {
  const client = cache();
  client.setQueryData(["task-runs", TASK_ID, "list"], {
    items: latest ? [latest] : [],
    total: latest ? 1 : 0,
  });
  if (latest) client.setQueryData(["task-run", latest.id], { ...latest, pending_question: "Ja?" });
  if (options.steps)
    client.setQueryData(["task-run-playbook", CONVERSATION_ID], {
      steps: options.steps,
      next_action: null,
    });
  return show(
    <TaskDetail
      task={task({ latest_run: latestRun(latest) })}
      permissions={options.permissions ?? ALL}
    />,
    client,
    options.locale,
  );
}

const STRIP_ACTIONS = ["answer", "continue", "usage", "ai_access", "review", "resume", "view"];
const strip = (markup: string) =>
  STRIP_ACTIONS.filter((action) => has(markup, `task-strip-${action}`));

describe("a run that waits for something the person cannot answer", () => {
  test("a budget wait names the budget, links the usage page and offers nothing to answer", async () => {
    const markup = await detail(run({ state: "waiting", waiting_reason: "budget" }));
    expect(strip(markup)).toEqual(["usage"]);
    expect(count(markup, 'data-slot="status-strip-action"')).toBe(1);
    expect(markup).toContain(">Nutzung ansehen</a>");
    expect(markup).toContain('href="/cockpit/usage"');
    expect(markup).toContain(
      "Der Lauf wartet auf KI-Kontingent und läuft von selbst weiter, sobald wieder Kontingent da ist.",
    );
    expect(slice(markup, "task-tile-waiting")).toContain("KI-Kontingent");
    expect(slice(markup, "task-tile-now")).toContain("wartet auf KI-Kontingent");
    expect(markup).not.toContain("Antworten");
    expect(markup).not.toContain("Wartet auf dich");
    const english = await detail(run({ state: "waiting", waiting_reason: "budget" }), {
      locale: "en",
    });
    expect(english).toContain(">View usage</a>");
    expect(slice(english, "task-tile-waiting")).toContain("AI allowance");
    const noStats = await detail(run({ state: "waiting", waiting_reason: "budget" }), {
      permissions: ALL.filter((permission) => permission !== "stats:read"),
    });
    expect(strip(noStats)).toEqual([]);
  });

  test("a missing AI access leads to the AI settings", async () => {
    const markup = await detail(run({ state: "waiting", waiting_reason: "ai_access" }));
    expect(strip(markup)).toEqual(["ai_access"]);
    expect(markup).toContain('href="/cockpit/settings?area=ai"');
    expect(markup).toContain(">KI-Zugang einrichten</a>");
    expect(slice(markup, "task-tile-waiting")).toContain("KI-Zugang");
  });

  test("a stuck or held run is resumed in its conversation, a question is answered there", async () => {
    for (const reason of ["no_progress", "turn_stopped"] as const) {
      const markup = await detail(run({ state: "waiting", waiting_reason: reason }));
      expect(strip(markup)).toEqual(["continue"]);
      expect(markup).toContain(">Fortsetzen</a>");
      expect(markup).toContain(`/chat/${CONVERSATION_ID}"`);
      expect(slice(markup, "task-tile-waiting")).toContain("dich");
    }
    for (const reason of ["question", "approval", "question_expired"] as const)
      expect(strip(await detail(run({ state: "waiting", waiting_reason: reason })))).toEqual([
        "answer",
      ]);
  });
});

describe("the overview at a glance", () => {
  test("steps are a vertical ordered list with a state per step and no repeated word", async () => {
    const markup = await detail(run({ state: "running" }), {
      steps: [
        { id: "confirm-result", label: "Ziel", status: "blocked" },
        { id: "fetch", label: "Wetter abrufen", status: "verified" },
        { id: "work", label: "Zusammenfassen", status: "in_progress" },
        { id: "ask", label: "Rückfrage klären", status: "waiting_for_input" },
        { id: "later", label: "Ablegen", status: "open" },
      ],
    });
    const list = markup.slice(markup.indexOf('data-testid="task-steps"'));
    const steps = list.slice(0, list.indexOf("</ol>"));
    expect(steps.slice(0, 80)).not.toContain("flex-wrap");
    expect(markup).toMatch(/<ol class="[^"]*flex-col[^"]*" data-testid="task-steps"/);
    expect([...steps.matchAll(/data-step-mark="([a-z]+)"/g)].map((match) => match[1])).toEqual([
      "done",
      "active",
      "waiting",
      "open",
      "open",
    ]);
    expect(steps.lastIndexOf("Ergebnis bestätigen")).toBeGreaterThan(steps.indexOf("Ablegen"));
    expect(steps).not.toContain(">offen<");
    expect(count(steps, "<svg")).toBe(5);
    const idle = await detail(null);
    const plain = idle.slice(idle.indexOf('data-testid="task-steps"'));
    expect(plain.slice(0, plain.indexOf("</ol>"))).not.toContain(">offen<");
  });

  test("the four tiles sit two by two on narrow screens without a fixed height", async () => {
    const markup = await detail(null);
    const tiles = markup.match(/<div class="([^"]*)" data-testid="task-tiles"/)?.[1] ?? "";
    expect(tiles.split(" ")).toContain("grid-cols-2");
    expect(tiles.split(" ")).toContain("@3xl:grid-cols-4");
    for (const tile of ["now", "waiting", "next", "usage"]) {
      const box = markup.match(
        new RegExp(`<div class="([^"]*)" data-slot="kpi-tile" data-testid="task-tile-${tile}"`),
      )?.[1];
      expect(box?.split(" ")).toContain("min-h-0");
      expect(box).not.toContain("min-h-35");
    }
    expect(render(<KpiTile label="A" note="B" testId="k" />)).toContain("min-h-35");
  });
});

describe("the form dialog fits every width", () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    value: `w${index}`,
    label: `demo-open-meteo-weather-with-a-very-long-name-${index}`,
  }));
  const fields = (workflowOptions = [{ value: "w1", label: "Zahlungsabgleich" }]) =>
    show(
      <TaskFormFields
        draft={emptyDraft("Europe/Berlin")}
        onChange={() => {}}
        workflowOptions={workflowOptions}
        connectorOptions={[{ value: "c1", label: "Buchhaltung" }]}
        choosesEnvironment={false}
      />,
      cache(),
    );

  test("a preselected environment says that it comes from the person's setup", async () => {
    const form = (environmentFromSetup: boolean, locale: "de" | "en" = "de") =>
      show(
        <TaskFormFields
          draft={{ ...emptyDraft("Europe/Berlin"), environment: "dev" }}
          onChange={() => {}}
          workflowOptions={[]}
          connectorOptions={[]}
          choosesEnvironment
          environmentFromSetup={environmentFromSetup}
        />,
        cache(),
        locale,
      );
    const shown = await form(true);
    expect(shown).toContain('data-testid="task-form-environment-default"');
    expect(shown).toContain("„Test“ ist aus deiner Einrichtung vorausgewählt.");
    expect(shown).toContain("unter Einstellungen › Einrichtung.");
    expect(await form(true, "en")).toContain("“Test” is preselected from your setup.");
    expect(await form(false)).not.toContain("task-form-environment-default");
    expect(fromSetup("dev", "dev")).toBe(true);
    expect(fromSetup("dev", "prod")).toBe(false);
    expect(fromSetup(null, "prod")).toBe(false);
  });

  test("the body has one shrinking column and never scrolls sideways", () => {
    const classes = DIALOG_BODY.split(" ");
    expect(classes).toContain("grid-cols-[minmax(0,1fr)]");
    expect(classes).toContain("overflow-x-hidden");
    expect(classes).toContain("min-w-0");
  });

  test("the six schedule options wrap in a grid instead of one scrolling row", async () => {
    const markup = await show(
      <TaskScheduleFields value={scheduleDraft(null, "Europe/Berlin")} onChange={() => {}} />,
      cache(),
    );
    const root = markup.match(/<div[^>]*data-testid="task-schedule-option"[^>]*>/)?.[0] ?? "";
    expect(root).toContain('data-slot="segmented-choices"');
    expect(root).toContain("grid-cols-2");
    expect(root).toContain("sm:grid-cols-3");
    expect(root).not.toContain("overflow-x-auto");
    expect(root).not.toContain("flex-nowrap");
    const item = markup.match(/<button[^>]*data-testid="task-schedule-option-custom"[^>]*>/)?.[0];
    expect(item).toContain("whitespace-normal");
    expect(item).not.toContain("whitespace-nowrap");
    const row = render(
      <SegmentedControl
        label="x"
        value="a"
        onValueChange={() => {}}
        options={[{ value: "a", label: "A" }]}
      />,
    );
    expect(row).toContain('data-slot="segmented-control"');
  });

  test("what may be used is a calm list: one name per row, plain font, long names cut with a title", async () => {
    const markup = await fields();
    const use = markup.slice(
      markup.indexOf('data-testid="task-form-use"'),
      markup.indexOf('data-testid="task-form-more"'),
    );
    expect(use).not.toContain("font-mono");
    expect(use).toContain('data-slot="check-list"');
    expect(use).toMatch(/<span class="[^"]*truncate[^"]*" title="Zahlungsabgleich">/);
    expect(has(markup, "task-form-workflows-filter")).toBe(false);
    const question = markup.match(/<legend id="task-form-use-label" class="([^"]*)"/)?.[1];
    const sibling = markup.match(/<label for="task-form-goal" class="([^"]*)"/)?.[1] ?? "-";
    for (const style of sibling.split(" ")) expect(question?.split(" ")).toContain(style);
    expect(use).not.toContain("<h2");
  });

  test("a long list gets a filter that narrows by name", async () => {
    const markup = await fields(many);
    expect(has(markup, "task-form-workflows-filter")).toBe(true);
    expect(has(markup, "task-form-connectors-filter")).toBe(false);
    expect(markup).toContain("Liste filtern: Workflows");
    expect(checkListMatches(many, " NAME-3 ").map((option) => option.value)).toEqual(["w3"]);
    expect(checkListMatches(many, "")).toHaveLength(9);
    const none = render(
      <CheckListField
        id="x"
        label="X"
        values={[]}
        onChange={() => {}}
        options={[]}
        empty="Nichts da."
      />,
    );
    expect(none).toContain("Nichts da.");
  });
});

describe("a continuation of the background driver in the conversation", () => {
  const message = (change: Record<string, unknown>): UiMessage =>
    ({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Continue working on the task. Update the playbook." }],
      model: null,
      created_at: "2026-11-19T09:00:00Z",
      ...change,
    }) as UiMessage;
  const shown = (value: UiMessage, locale: "de" | "en" = "de") =>
    render(
      <ChatMessage
        message={value}
        messageIndex={3}
        pendingApprovalId={null}
        approval={null}
        choice={null}
        form={null}
        onForm={() => {}}
        onChoice={() => {}}
        approvalBusy={false}
        approvalError={false}
        onApproval={() => {}}
        onDecision={() => {}}
        onReauth={() => {}}
        onAutomationAdjust={() => {}}
        onAutomationSingleRun={() => {}}
        onInstruction={() => {}}
        liveReviews={new Set()}
        nameFor={() => null}
        workflowNameFor={() => null}
      />,
      locale,
    );

  test("is one quiet divider in the viewer's language, never a bubble with the prompt", () => {
    const markup = shown(message({ origin: "task_run_continuation" }));
    expect(has(markup, "chat-message-3-continues")).toBe(true);
    expect(markup).toContain('data-cockpit-ui="chat-run-continues"');
    expect(markup).not.toContain("<button");
    expect(markup).toContain("SubKit arbeitet weiter");
    expect(markup).not.toContain("Continue working");
    expect(has(markup, "chat-message-3-role")).toBe(false);
    expect(shown(message({ origin: "task_run_continuation" }), "en")).toContain("SubKit continues");
  });

  test("a message without the marker stays what the person wrote", () => {
    const markup = shown(message({}));
    expect(has(markup, "chat-message-3-continues")).toBe(false);
    expect(has(markup, "chat-message-3-role")).toBe(true);
  });
});
