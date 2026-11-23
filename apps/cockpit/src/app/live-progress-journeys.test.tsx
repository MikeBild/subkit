import { expect } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  isolated as isolatedIn,
  mount,
  NOW,
  run,
  runDetail,
  WORKFLOW,
  workflow,
} from "./journey-fixtures";

const isolated = (name: string, body: () => Promise<void>) =>
  isolatedIn(import.meta.path, name, body);

const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const CONNECTOR = "77777777-7777-4777-8777-777777777777";
const LIVE_RUN = "88888888-8888-4888-8888-888888888888";
const OCCURRENCE = "99999999-9999-4999-8999-999999999999";
const T0 = Date.parse(NOW);

type Frames = { push(event: string, data: unknown, id?: string): void };

function sseStream(): { response: () => Response; frames: Frames } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const queued: string[] = [];
  const write = (chunk: string) => {
    if (controller) controller.enqueue(encoder.encode(chunk));
    else queued.push(chunk);
  };
  return {
    response: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(open) {
            controller = open;
            for (const chunk of queued.splice(0)) open.enqueue(encoder.encode(chunk));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    frames: {
      push: (event, data, id) =>
        write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    },
  };
}

function frozenClock(): { advance(ms: number): void } {
  let offset = 0;
  Date.now = () => T0 + offset;
  return {
    advance: (ms) => {
      offset += ms;
    },
  };
}

const connectorRoute = {
  "/v1/connectors": () => ({
    items: [{ id: CONNECTOR, slug: "tracker", display_name: "Tracker", driver: "http" }],
    next_cursor: null,
    total: 1,
  }),
};

function chatRoutes(turn: ReturnType<typeof sseStream>) {
  return {
    ...connectorRoute,
    "/v1/conversations": (_url: URL, init?: RequestInit) =>
      init?.method === "POST" ? turn.response() : { items: [], next_cursor: null, total: 0 },
  };
}

const readIssues = (callId: string) => ({
  type: "tool_call_start",
  call_id: callId,
  tool: "call_connector",
  input_partial: { connector_id: CONNECTOR, method: "GET", path: "/projects/app/issues" },
});

isolated("Chat › the activity line follows the steps of a running turn", async () => {
  const clock = frozenClock();
  const turn = sseStream();
  const app = await mount("/chat?prompt=Offene%20Issues", chatRoutes(turn));
  await app.click("chat-composer-submit");
  const line = () => app.find("chat-activity-line");
  expect(line()?.getAttribute("role")).toBe("status");
  expect(line()?.getAttribute("aria-live")).toBe("polite");
  expect(line()?.textContent).toBe(translate("de", "chat.activity.model"));
  expect(app.find("chat-activity-indicator")?.dataset.motion).toBe("full");

  turn.frames.push("conversation_started", { conversation: { id: CONVERSATION } });
  turn.frames.push("tool_call_start", readIssues("call-1"));
  await app.settle();
  expect(line()?.textContent).toBe("Liest Issues in Tracker");
  expect(line()?.dataset.phase).toBe("tool");

  turn.frames.push("tool_result", {
    type: "tool_result",
    call_id: "call-1",
    tool: "call_connector",
    output: { ok: false, error: "upstream timeout" },
  });
  turn.frames.push("tool_call_start", readIssues("call-2"));
  turn.frames.push("activity", {
    type: "activity",
    phase: "tool",
    label: "call_connector",
    tool_name: "call_connector",
    call_id: "call-2",
    retry: { attempt: 1, of: 4 },
  });
  await app.settle();
  expect(line()?.textContent).toBe(
    "Liest Issues in Tracker – fehlgeschlagen, neuer Versuch (1 von 4)",
  );
  expect(app.find("chat-activity-idle")).toBeNull();

  clock.advance(3 * 60_000);
  await app.settle(260);
  expect(app.find("chat-activity-idle")?.textContent).toBe("· 3 min");
  expect(line()?.contains(app.find("chat-activity-idle"))).toBe(false);

  turn.frames.push("tool_result", {
    type: "tool_result",
    call_id: "call-2",
    tool: "call_connector",
    output: { ok: true },
  });
  await app.settle();
  expect(line()?.textContent).toBe(translate("de", "chat.activity.model"));

  const toggle = app.find("chat-activity-history-toggle");
  const history = app.find("chat-activity-history");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(toggle?.getAttribute("aria-controls")).toBe(history?.id);
  expect(history?.hidden).toBe(true);
  await app.click("chat-activity-history-toggle");
  expect(app.find("chat-activity-history-toggle")?.getAttribute("aria-expanded")).toBe("true");
  expect(app.find("chat-activity-history")?.hidden).toBe(false);
  const steps = [
    ...app.dom.window.document.querySelectorAll<HTMLElement>(
      '[data-testid="chat-activity-history-step"]',
    ),
  ];
  expect(steps.map((step) => step.dataset.outcome)).toEqual(["failed", "ok"]);

  turn.frames.push("text_delta", { type: "text_delta", text: "Drei offene Issues." });
  await app.settle();
  expect(line()?.textContent).toBe(translate("de", "chat.activity.responding"));
});

isolated("Chat › reduced motion keeps the activity indicator still", async () => {
  const turn = sseStream();
  const app = await mount("/chat?prompt=Hallo", chatRoutes(turn), { reducedMotion: true });
  await app.click("chat-composer-submit");
  const indicator = app.find("chat-activity-indicator");
  expect(indicator?.dataset.motion).toBe("reduced");
  expect(indicator?.querySelector(".animate-ping, .animate-spin")).toBeNull();
  expect(indicator?.getAttribute("aria-hidden")).toBe("true");
});

const liveRun = {
  ...run,
  id: LIVE_RUN,
  execution_id: LIVE_RUN,
  status: "running",
  request_source: "scheduler",
  finished_at: null,
};

const step = (key: string, index: number, status: string, startedAt: string) => ({
  id: `step-${key}`,
  step_key: key,
  step_index: index,
  kind: "request",
  status,
  held: false,
  duration_ms: null,
  retry_count: 0,
  result_storage_uri: null,
  result_sha256: null,
  result_preview: null,
  credential_snapshots: [],
  started_at: startedAt,
  finished_at: status === "running" ? null : startedAt,
});

function scheduleRoutes(live: ReturnType<typeof sseStream>, steps: () => unknown[]) {
  return {
    "/v1/cockpit/events/stream": () => live.response(),
    "/v1/executions": (url: URL) =>
      url.searchParams.get("status") === "running" &&
      url.searchParams.get("request_source") === "scheduler"
        ? { items: [liveRun], next_cursor: null, total: 1 }
        : { items: [run], next_cursor: null, total: 1 },
    [`/v1/executions/${LIVE_RUN}`]: () => ({ ...runDetail, ...liveRun, outcome: null }),
    [`/v1/executions/${LIVE_RUN}/steps`]: () => ({ items: steps(), next_cursor: null }),
    [`/v1/executions/${LIVE_RUN}/cost`]: () => ({}),
    [`/v1/workflows/${WORKFLOW}/schedule-occurrences`]: () => ({
      items: [
        {
          id: OCCURRENCE,
          workflow_id: WORKFLOW,
          task_id: null,
          schedule_id: null,
          due_at: NOW,
          last_due_at: NOW,
          started_at: NOW,
          state: "ran",
          reason_code: null,
          skipped_count: 0,
          execution_id: LIVE_RUN,
          task_run_id: null,
          run_outcome: "running",
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      next_before: null,
    }),
  };
}

isolated("Schedules › a running occurrence shows its current step live", async () => {
  const live = sseStream();
  let current = [step("fetch_items", 0, "running", NOW)];
  const app = await mount(
    `/workflows/${WORKFLOW}?tab=schedule`,
    scheduleRoutes(live, () => current),
  );
  expect(app.text()).toContain(workflow.name);
  const occurrenceStep = () => app.find(`schedule-occurrence-live-${OCCURRENCE}-step`);
  expect(occurrenceStep()?.textContent).toBe("Läuft gerade: Schritt „fetch_items“");
  expect(occurrenceStep()?.getAttribute("aria-live")).toBe("polite");
  expect(app.find(`schedule-occurrence-live-${OCCURRENCE}-indicator`)?.dataset.motion).toBe("full");
  expect(app.find("workflow-live-run-step")?.textContent).toBe(
    "Läuft gerade: Schritt „fetch_items“",
  );

  current = [
    step("fetch_items", 0, "succeeded", NOW),
    step("summarize", 1, "running", "2026-11-23T10:00:05.000Z"),
  ];
  live.frames.push(
    "execution.step.started",
    { execution_id: LIVE_RUN, workflow_id: WORKFLOW },
    "41",
  );
  await app.settle(90);
  expect(occurrenceStep()?.textContent).toBe("Läuft gerade: Schritt „summarize“");
  expect(app.find("workflow-live-run-step")?.textContent).toBe("Läuft gerade: Schritt „summarize“");

  await app.click(`schedule-occurrence-open-${OCCURRENCE}`);
  app.at(`/runs/${LIVE_RUN}`);
});

isolated("Schedules › the automation panel links the scheduled run in progress", async () => {
  const live = sseStream();
  const app = await mount(
    `/workflows/${WORKFLOW}`,
    scheduleRoutes(live, () => [step("fetch_items", 0, "running", NOW)]),
    { reducedMotion: true },
  );
  const panel = app.find("workflow-live-run-panel");
  expect(panel?.getAttribute("aria-labelledby")).toBe("workflow-live-run-title");
  expect(panel?.textContent).toContain(translate("de", "ops.sched.live.title"));
  expect(app.find("workflow-live-run-indicator")?.dataset.motion).toBe("reduced");
  await app.click("workflow-live-run-open");
  app.at(`/runs/${LIVE_RUN}`);
});
