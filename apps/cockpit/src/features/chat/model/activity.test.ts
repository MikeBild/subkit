import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  ACTIVITY_IDLE_AFTER_MS,
  activityLine,
  pathResource,
  recentSteps,
  reduceActivity,
  startActivity,
  type TurnActivity,
} from "./activity";
import { type ActivityNames, activitySentence, stepOutcomeKey } from "./activity-labels";

const T0 = 1_700_000_000_000;
const CONNECTOR = "c0ffee00-0000-4000-8000-000000000001";
const names: ActivityNames = {
  connectorName: (id) => (id === CONNECTOR ? "Tracker" : null),
  workflowName: (slug) => (slug === "weekly-digest" ? "Weekly digest" : null),
};
const de = (key: TranslationKey, params?: Record<string, string | number>) =>
  translate("de", key, params);
const en = (key: TranslationKey, params?: Record<string, string | number>) =>
  translate("en", key, params);

type Frame = { type: string; [key: string]: unknown };

function play(frames: readonly (readonly [number, Frame])[]): TurnActivity {
  return frames.reduce(
    (state, [offset, frame]) => reduceActivity(state, frame, T0 + offset),
    startActivity(T0),
  );
}

const connectorCall = (callId: string, path = "/repos/acme/app/issues", method = "GET") =>
  [
    0,
    {
      type: "tool_call_start",
      call_id: callId,
      tool: "call_connector",
      input_partial: { connector_id: CONNECTOR, method, path },
    },
  ] as const;

describe("pathResource", () => {
  test("names the last meaningful path segment", () => {
    expect(pathResource("/repos/acme/app/issues")).toBe("Issues");
    expect(pathResource("/v2/droplets")).toBe("Droplets");
    expect(pathResource("https://api.example.com/v1/open_tickets?page=2")).toBe("Open tickets");
  });

  test("skips ids, placeholders and versions and gives up on non paths", () => {
    expect(pathResource("/items/12345")).toBe("Items");
    expect(pathResource("/items/{id}")).toBe("Items");
    expect(pathResource("/v1/2f1e9c3a-1111-4111-8111-000000000000")).toBeNull();
    expect(pathResource("select * from users")).toBeNull();
    expect(pathResource(null)).toBeNull();
  });
});

describe("reduceActivity", () => {
  test("a turn without events waits for the model", () => {
    const line = activityLine(startActivity(T0), T0 + 1_000);
    expect(line).toEqual({ now: { kind: "model" }, retry: null, idleMinutes: null });
    expect(activitySentence(de, line, names)).toBe("Wartet auf das Modell");
  });

  test("a running connector call names the app and the resource", () => {
    const state = play([connectorCall("call-1")]);
    const line = activityLine(state, T0 + 2_000);
    expect(line.now.kind).toBe("tool");
    expect(activitySentence(de, line, names)).toBe("Liest Issues in Tracker");
    expect(activitySentence(en, line, names)).toBe("Reading Issues in Tracker");
  });

  test("a write names the target and falls back without a resource", () => {
    const write = play([connectorCall("call-1", "/", "POST")]);
    expect(activitySentence(de, activityLine(write, T0), names)).toBe("Schreibt Daten in Tracker");
  });

  test("a workflow tool names the workflow", () => {
    const state = play([[0, { type: "tool_call_start", call_id: "w", tool: "wf_weekly-digest" }]]);
    expect(activitySentence(de, activityLine(state, T0), names)).toBe(
      de("chat.activity.step.workflow", { name: "Weekly digest" }),
    );
  });

  test("tool_call_end only completes the input; the result ends the step", () => {
    const state = play([
      connectorCall("call-1"),
      [10, { type: "tool_call_end", call_id: "call-1", input: { connector_id: CONNECTOR } }],
    ]);
    expect(activityLine(state, T0 + 20).now.kind).toBe("tool");
    const done = reduceActivity(
      state,
      { type: "tool_result", call_id: "call-1", output: { ok: true } },
      T0 + 1_500,
    );
    expect(activityLine(done, T0 + 1_600).now).toEqual({ kind: "model" });
    expect(recentSteps(done)).toHaveLength(1);
    expect(recentSteps(done)[0]).toMatchObject({ endedAt: T0 + 1_500, ok: true });
  });

  test("an idle activity frame closes the step and records failure", () => {
    const state = play([
      connectorCall("call-1"),
      [
        900,
        {
          type: "activity",
          phase: "idle",
          label: "last",
          last_completed: { tool_name: "call_connector", ok: false, duration_ms: 900 },
        },
      ],
    ]);
    const [step] = recentSteps(state);
    expect(step?.ok).toBe(false);
    expect(step && stepOutcomeKey(step)).toBe("chat.activity.history.failed");
  });

  test("a tool retry shows the attempt against the cap while the step runs", () => {
    const state = play([
      connectorCall("call-1"),
      [100, { type: "tool_result", call_id: "call-1", output: { ok: false, error: "boom" } }],
      connectorCall("call-2"),
      [
        200,
        {
          type: "activity",
          phase: "tool",
          label: "call_connector",
          call_id: "call-2",
          retry: { attempt: 1, of: 4 },
        },
      ],
    ]);
    const line = activityLine(state, T0 + 300);
    expect(line.retry).toEqual({ scope: "tool", attempt: 1, of: 4 });
    expect(activitySentence(de, line, names)).toBe(
      "Liest Issues in Tracker – fehlgeschlagen, neuer Versuch (1 von 4)",
    );
    const recovered = reduceActivity(
      state,
      { type: "tool_result", call_id: "call-2", output: { ok: true } },
      T0 + 400,
    );
    expect(activityLine(recovered, T0 + 500).retry).toBeNull();
  });

  test("a retry frame for a call that is not running is ignored", () => {
    const state = play([
      [0, { type: "activity", phase: "tool", call_id: "ghost", retry: { attempt: 1, of: 4 } }],
    ]);
    expect(state.retry).toBeNull();
  });

  test("a model fallback shows the model retry until text arrives", () => {
    const state = play([
      [0, { type: "activity", phase: "composing", label: "x", retry: { attempt: 1, of: 1 } }],
    ]);
    const line = activityLine(state, T0 + 100);
    expect(activitySentence(de, line, names)).toBe(
      "Wartet auf das Modell – fehlgeschlagen, neuer Versuch (1 von 1)",
    );
    const writing = reduceActivity(state, { type: "text_delta", text: "Hi" }, T0 + 200);
    expect(activityLine(writing, T0 + 300)).toEqual({
      now: { kind: "writing" },
      retry: null,
      idleMinutes: null,
    });
  });

  test("composing heartbeats do not reset the idle clock", () => {
    const state = play([
      [0, { type: "activity", phase: "composing", label: "composing reply" }],
      [5_000, { type: "activity", phase: "composing", label: "composing reply" }],
    ]);
    expect(state.since).toBe(T0);
  });

  test("idle time appears only after the threshold and counts whole minutes", () => {
    const state = play([connectorCall("call-1")]);
    expect(activityLine(state, T0 + ACTIVITY_IDLE_AFTER_MS - 1).idleMinutes).toBeNull();
    expect(activityLine(state, T0 + ACTIVITY_IDLE_AFTER_MS).idleMinutes).toBe(1);
    expect(activityLine(state, T0 + 3 * 60_000 + 59_000).idleMinutes).toBe(3);
  });

  test("the history keeps the last four finished steps in order", () => {
    const frames: [number, Frame][] = [];
    for (let index = 1; index <= 6; index += 1) {
      frames.push([
        index * 10,
        { type: "tool_call_start", call_id: `c${index}`, tool: "find_skill" },
      ]);
      frames.push([index * 10 + 5, { type: "tool_result", call_id: `c${index}`, output: {} }]);
    }
    frames.push([100, { type: "tool_call_start", call_id: "open", tool: "find_skill" }]);
    const state = play(frames);
    expect(recentSteps(state).map((step) => step.callId)).toEqual(["c3", "c4", "c5", "c6"]);
  });

  test("duplicate starts and unknown results leave the state alone", () => {
    const state = play([connectorCall("call-1")]);
    expect(reduceActivity(state, connectorCall("call-1")[1], T0 + 5)).toBe(state);
    expect(reduceActivity(state, { type: "tool_result", call_id: "nope" }, T0 + 5)).toBe(state);
    expect(reduceActivity(state, { type: "citations" }, T0 + 5)).toBe(state);
  });
});
