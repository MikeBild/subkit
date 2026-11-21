import { describe, expect, test } from "bun:test";
import { AT, BROWSER_SCRIPT, COMPUTER_SCRIPT, SAVE_CONFIRMATION } from "./live-view.fixture.ts";
import {
  askExpiresAt,
  askRows,
  decideLive,
  INITIAL_LIVE,
  isActive,
  LIVE_CAPABILITIES,
  LIVE_SOURCES,
  type LiveEvent,
  type LiveState,
  type LiveStatus,
  liveSnapshot,
  opensWindow,
  overlayVisible,
  pendingAsk,
  reduceLive,
  reduceLiveAll,
  stopAvailable,
} from "./live-view-model.ts";

const DEADLINE = Date.parse(SAVE_CONFIRMATION.deadline_at);
const STATUSES: LiveStatus[] = [
  "idle",
  "running",
  "asking",
  "typing",
  "handover",
  "stopped",
  "lost",
  "finished",
];
const asking = () => reduceLiveAll(INITIAL_LIVE, COMPUTER_SCRIPT);
const statuses = (state: LiveState) => state.steps.map((step) => step.status);
const at = (status: LiveStatus, extra: Partial<LiveState> = {}): LiveState => ({
  ...INITIAL_LIVE,
  session_id: "s",
  status,
  ...extra,
});
const started: LiveEvent = {
  type: "started",
  session_id: "s",
  capability: "computer",
  source: "chat",
  target: "Numbers",
};
const step = (command_id: string, status: LiveState["steps"][number]["status"]) => ({
  command_id,
  kind: "computer.press" as const,
  target: "OK",
  status,
});

describe("initial state", () => {
  test("is idle, closed and empty", () => {
    expect(INITIAL_LIVE).toEqual({
      session_id: null,
      capability: "computer",
      source: "chat",
      target: "",
      status: "idle",
      steps: [],
      ask: null,
      page_changed: false,
      injection: false,
      screenshot: 0,
      error: null,
      open: false,
    });
  });
});

describe("vocabulary", () => {
  test("names both live capabilities and the three sources", () => {
    expect(LIVE_CAPABILITIES).toEqual(["browser", "computer"]);
    expect(LIVE_SOURCES).toEqual(["chat", "schedule", "task"]);
  });
});

describe("selectors", () => {
  test("only running, asking, typing and handover are active; lost can still be stopped", () => {
    expect(STATUSES.filter((status) => isActive(at(status)))).toEqual([
      "running",
      "asking",
      "typing",
      "handover",
    ]);
    expect(STATUSES.filter((status) => stopAvailable(at(status)))).toEqual([
      "running",
      "asking",
      "typing",
      "handover",
      "lost",
    ]);
  });

  test("the overlay pill shows only for active computer use", () => {
    expect(STATUSES.filter((status) => overlayVisible(at(status)))).toEqual([
      "running",
      "asking",
      "typing",
      "handover",
    ]);
    expect(overlayVisible(at("running", { capability: "browser" }))).toBe(false);
  });

  test("a schedule never opens the window by itself", () => {
    expect(opensWindow("chat")).toBe(true);
    expect(opensWindow("task")).toBe(true);
    expect(opensWindow("schedule")).toBe(false);
  });
});

describe("a confirmation", () => {
  test("is pending until it expires and only while asking", () => {
    const state = asking();
    expect(pendingAsk(state, AT)?.confirmation_id).toBe("k1");
    expect(pendingAsk(state, DEADLINE - 1)?.confirmation_id).toBe("k1");
    expect(pendingAsk(state, DEADLINE)).toBeNull();
    expect(pendingAsk({ ...state, status: "lost" }, AT)).toBeNull();
    expect(pendingAsk({ ...state, ask: null }, AT)).toBeNull();
  });

  test("expires at the deadline of its confirmation", () => {
    expect(askExpiresAt(asking())).toBe(DEADLINE);
    expect(askExpiresAt({ ...asking(), status: "running" })).toBeNull();
    expect(askExpiresAt({ ...asking(), ask: null })).toBeNull();
  });

  test("shows the redacted target as its one row", () => {
    expect(askRows(SAVE_CONFIRMATION, "Aktion")).toEqual([["Aktion", SAVE_CONFIRMATION.target]]);
  });
});

describe("reduceLive", () => {
  test("a computer-use run from chat opens the window and asks before saving", () => {
    const state = asking();
    expect(state).toMatchObject({
      session_id: "s-computer",
      capability: "computer",
      source: "chat",
      target: "Numbers",
      status: "asking",
      open: true,
      screenshot: 1,
    });
    expect(statuses(state)).toEqual(["done", "done", "waiting"]);
    expect(state.ask).toEqual({
      command_id: "c3",
      confirmation_id: "k1",
      confirmation: SAVE_CONFIRMATION,
      asked_at: AT,
    });
  });

  test("a scheduled browser run hands over sign-in and stays closed", () => {
    const state = reduceLiveAll(INITIAL_LIVE, BROWSER_SCRIPT);
    expect(state).toMatchObject({ status: "handover", open: false, capability: "browser" });
    expect(statuses(state)).toEqual(["waiting"]);
  });

  test("a new start replaces everything from the session before", () => {
    const state = reduceLive(
      { ...asking(), injection: true, error: "privateSuggested", page_changed: true },
      started,
    );
    expect(state).toEqual({
      ...INITIAL_LIVE,
      session_id: "s",
      target: "Numbers",
      status: "running",
      open: true,
    });
    expect(
      reduceLive(INITIAL_LIVE, { ...started, capability: "browser", source: "task" }),
    ).toMatchObject({ capability: "browser", source: "task" });
  });

  test("nothing happens without a session", () => {
    const events: LiveEvent[] = [
      { type: "screenshot" },
      { type: "injection" },
      { type: "reconnected" },
      { type: "owner_typing" },
      { type: "owner_idle" },
      { type: "finished" },
      { type: "device_lost" },
      { type: "running", command_id: "c", kind: "computer.press", target: "OK" },
    ];
    for (const event of events) expect(reduceLive(INITIAL_LIVE, event)).toBe(INITIAL_LIVE);
  });

  test("screenshots count up and an injection is remembered, even after the end", () => {
    const done = at("finished");
    expect(reduceLive(done, { type: "screenshot" }).screenshot).toBe(1);
    expect(
      reduceLive(reduceLive(done, { type: "screenshot" }), { type: "screenshot" }).screenshot,
    ).toBe(2);
    expect(reduceLive(done, { type: "injection" }).injection).toBe(true);
  });

  test("typing pauses a running step until the person is idle again", () => {
    expect(reduceLive(at("running"), { type: "owner_typing" }).status).toBe("typing");
    expect(reduceLive(at("asking"), { type: "owner_typing" }).status).toBe("asking");
    expect(reduceLive(at("typing"), { type: "owner_idle" }).status).toBe("running");
    const handover = at("handover");
    expect(reduceLive(handover, { type: "owner_idle" })).toBe(handover);
    const running = at("running");
    expect(reduceLive(running, { type: "owner_typing" })).not.toBe(running);
    const typing = at("typing");
    expect(reduceLive(typing, { type: "owner_typing" })).toBe(typing);
  });

  test("a lost device comes back asking when a confirmation is open, otherwise running", () => {
    const lost = reduceLive(asking(), { type: "device_lost" });
    expect(lost.status).toBe("lost");
    expect(reduceLive(lost, { type: "reconnected" }).status).toBe("asking");
    expect(reduceLive({ ...lost, ask: null }, { type: "reconnected" }).status).toBe("running");
    const running = at("running");
    expect(reduceLive(running, { type: "reconnected" })).toBe(running);
    const stopped = at("stopped");
    expect(reduceLive(stopped, { type: "device_lost" })).toBe(stopped);
  });

  test("finishing marks queued steps as not run and clears the question", () => {
    for (const status of ["running", "lost"] as const) {
      const state = reduceLive(
        at(status, { steps: [step("a", "done"), step("b", "queued")], page_changed: true }),
        { type: "finished" },
      );
      expect(state.status).toBe("finished");
      expect(statuses(state)).toEqual(["done", "notRun"]);
      expect(state.page_changed).toBe(false);
    }
    expect(reduceLive(asking(), { type: "finished" }).ask).toBeNull();
    const stopped = at("stopped");
    expect(reduceLive(stopped, { type: "finished" })).toBe(stopped);
  });

  test("steps change only while the run is active", () => {
    for (const status of ["stopped", "finished", "lost"] as const) {
      const state = at(status);
      expect(
        reduceLive(state, {
          type: "running",
          command_id: "c",
          kind: "computer.press",
          target: "OK",
        }),
      ).toBe(state);
    }
  });

  test("queued steps are added once and started steps keep their place", () => {
    const one = reduceLive(at("running"), {
      type: "queued",
      command_id: "a",
      kind: "computer.press",
      target: "OK",
    });
    expect(
      reduceLive(one, { type: "queued", command_id: "a", kind: "computer.press", target: "OK" }),
    ).toBe(one);
    const two = reduceLive(one, {
      type: "running",
      command_id: "b",
      kind: "computer.type",
      target: "Feld",
    });
    const three = reduceLive(two, {
      type: "running",
      command_id: "a",
      kind: "computer.press",
      target: "OK",
    });
    expect(three.steps).toEqual([
      { command_id: "a", kind: "computer.press", target: "OK", status: "running" },
      { command_id: "b", kind: "computer.type", target: "Feld", status: "running" },
    ]);
  });

  test("results set the step status", () => {
    const base = at("running", { steps: [step("a", "running"), step("b", "queued")] });
    const result = (result: Extract<LiveEvent, { type: "result" }>["result"]) =>
      reduceLive(base, { type: "result", command_id: "a", result });
    expect(statuses(result({ status: "done", output: 1, evidence: {} }))).toEqual([
      "done",
      "queued",
    ]);
    expect(statuses(result({ status: "failed", code: "x", detail: "" }))).toEqual([
      "failed",
      "queued",
    ]);
    expect(
      statuses(result({ status: "confirmation_required", binding_hash: "h", target: "t" })),
    ).toEqual(["waiting", "queued"]);
    expect(statuses(result({ status: "refused", code: "blocked_app", detail: "" }))).toEqual([
      "refused",
      "queued",
    ]);
    expect(result({ status: "refused", code: "blocked_app", detail: "" }).status).toBe("running");
  });

  test("a stop result or stopped refusal stops the whole run", () => {
    const base = at("running", { steps: [step("a", "running"), step("b", "queued")] });
    for (const result of [
      { status: "stopped" } as const,
      { status: "refused", code: "stopped", detail: "" } as const,
    ]) {
      const state = reduceLive(base, { type: "result", command_id: "a", result });
      expect(state.status).toBe("stopped");
      expect(statuses(state)).toEqual(["stopped", "notRun"]);
    }
  });

  test("a refused file dialog names who uses it and keeps the session going", () => {
    const refused = (detail: string) =>
      reduceLive(at("running", { steps: [step("a", "running")] }), {
        type: "result",
        command_id: "a",
        result: { status: "refused", code: "blocked_app", detail },
      });
    expect(
      refused(
        "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.",
      ),
    ).toMatchObject({ status: "running", error: "fileDialog" });
    expect(
      statuses(
        refused(
          "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.",
        ),
      ),
    ).toEqual(["refused"]);
    expect(refused("other")).toMatchObject({ status: "running", error: null });
    expect(statuses(refused("other"))).toEqual(["refused"]);
    expect(
      reduceLive(at("running", { steps: [step("a", "running")] }), {
        type: "result",
        command_id: "a",
        result: {
          status: "refused",
          code: "outside_allowance",
          detail:
            "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.",
        },
      }).error,
    ).toBeNull();
  });

  test("a suggested private address ends the run with the error", () => {
    const state = reduceLive(
      at("running", { steps: [step("a", "running"), step("b", "queued")] }),
      {
        type: "result",
        command_id: "a",
        result: { status: "refused", code: "private_address", detail: "" },
      },
    );
    expect(state).toMatchObject({ status: "finished", error: "privateSuggested" });
    expect(statuses(state)).toEqual(["refused", "notRun"]);
  });

  test("a stale page while asking keeps the question and flags the change", () => {
    const stale = reduceLive(asking(), {
      type: "result",
      command_id: "c3",
      result: { status: "refused", code: "stale", detail: "" },
    });
    expect(stale).toMatchObject({ status: "asking", page_changed: true });
    expect(statuses(stale)).toEqual(["done", "done", "waiting"]);
    const asked = reduceLive(stale, {
      type: "asked",
      command_id: "c3",
      confirmation_id: "k2",
      confirmation: SAVE_CONFIRMATION,
      at: AT + 5,
    });
    expect(asked).toMatchObject({
      page_changed: true,
      ask: { confirmation_id: "k2", asked_at: AT + 5 },
    });
    const elsewhere = reduceLive(asking(), {
      type: "result",
      command_id: "c1",
      result: { status: "refused", code: "stale", detail: "" },
    });
    expect(elsewhere.page_changed).toBe(false);
    expect(statuses(elsewhere)).toEqual(["refused", "done", "waiting"]);
    const other = reduceLive(asking(), {
      type: "result",
      command_id: "c3",
      result: { status: "refused", code: "blocked_app", detail: "" },
    });
    expect(other.page_changed).toBe(false);
    expect(statuses(other)).toEqual(["done", "done", "refused"]);
    const unasked = reduceLive(at("running", { steps: [step("a", "running")] }), {
      type: "result",
      command_id: "a",
      result: { status: "refused", code: "stale", detail: "" },
    });
    expect(statuses(unasked)).toEqual(["refused"]);
  });
});

describe("decideLive", () => {
  test("stop ends the run once and asks main to stop exactly once", () => {
    const first = decideLive(asking(), { type: "stop" });
    expect(first.effects).toEqual([{ kind: "stop" }]);
    expect(first.state.status).toBe("stopped");
    expect(first.state.ask).toBeNull();
    expect(statuses(first.state)).toEqual(["done", "done", "stopped"]);
    expect(decideLive(first.state, { type: "stop" })).toEqual({ state: first.state, effects: [] });
    const lost = decideLive(at("lost"), { type: "stop" });
    expect(lost.effects).toEqual([{ kind: "stop" }]);
    for (const status of ["idle", "finished"] as const)
      expect(decideLive(at(status), { type: "stop" }).effects).toEqual([]);
  });

  test("stop turns running and waiting steps into stopped and queued ones into not run", () => {
    const state = decideLive(
      at("running", {
        steps: [step("a", "done"), step("b", "running"), step("c", "waiting"), step("d", "queued")],
      }),
      { type: "stop" },
    ).state;
    expect(statuses(state)).toEqual(["done", "stopped", "stopped", "notRun"]);
  });

  test("closing the window never stops the run", () => {
    const result = decideLive(asking(), { type: "close" });
    expect(result.effects).toEqual([]);
    expect(result.state).toEqual({ ...asking(), open: false });
    expect(decideLive(result.state, { type: "show" })).toEqual({ state: asking(), effects: [] });
    expect(decideLive(INITIAL_LIVE, { type: "show" }).state.open).toBe(false);
  });

  test("allowing confirms once and runs the step", () => {
    const result = decideLive(
      { ...asking(), page_changed: true },
      { type: "decide", allow: true, now: AT },
    );
    expect(result.effects).toEqual([
      { kind: "confirm", confirmation_id: "k1", decision: "confirm" },
    ]);
    expect(result.state).toMatchObject({ status: "running", ask: null, page_changed: false });
    expect(statuses(result.state)).toEqual(["done", "done", "running"]);
  });

  test("denying declines, refuses the step and ends the run", () => {
    const base = reduceLive(asking(), {
      type: "queued",
      command_id: "c4",
      kind: "computer.press",
      target: "OK",
    });
    const result = decideLive(base, { type: "decide", allow: false, now: AT });
    expect(result.effects).toEqual([
      { kind: "confirm", confirmation_id: "k1", decision: "decline" },
    ]);
    expect(result.state).toMatchObject({ status: "finished", ask: null });
    expect(statuses(result.state)).toEqual(["done", "done", "refused", "notRun"]);
  });

  test("an expired or missing question cannot be answered", () => {
    const state = asking();
    expect(decideLive(state, { type: "decide", allow: true, now: DEADLINE })).toEqual({
      state,
      effects: [],
    });
    const running = at("running");
    expect(decideLive(running, { type: "decide", allow: true, now: AT })).toEqual({
      state: running,
      effects: [],
    });
  });

  test("handing back resumes the waiting step", () => {
    const handover = reduceLiveAll(INITIAL_LIVE, BROWSER_SCRIPT);
    const result = decideLive(handover, { type: "hand_back" });
    expect(result.effects).toEqual([{ kind: "hand_back", command_id: "b1" }]);
    expect(result.state.status).toBe("running");
    expect(statuses(result.state)).toEqual(["running"]);
    expect(decideLive(asking(), { type: "hand_back" })).toEqual({ state: asking(), effects: [] });
    const second = decideLive(
      at("handover", { steps: [step("a", "done"), step("b", "waiting")] }),
      {
        type: "hand_back",
      },
    );
    expect(second.effects).toEqual([{ kind: "hand_back", command_id: "b" }]);
    expect(statuses(second.state)).toEqual(["done", "running"]);
    const empty = at("handover");
    expect(decideLive(empty, { type: "hand_back" })).toEqual({ state: empty, effects: [] });
  });
});

describe("liveSnapshot", () => {
  test("hides an expired question and adds stop and overlay", () => {
    expect(liveSnapshot(asking(), AT)).toMatchObject({
      stoppable: true,
      overlay: true,
      ask: { confirmation_id: "k1" },
    });
    expect(liveSnapshot(asking(), DEADLINE)).toMatchObject({ ask: null });
    expect(liveSnapshot(at("finished"), AT)).toMatchObject({ stoppable: false, overlay: false });
  });
});
