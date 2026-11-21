import { FILE_DIALOG_REFUSAL } from "@shared/device/computer.ts";
import type { LocalConfirmation } from "@shared/device/confirmation.ts";
import type { DeviceCommandKind, DeviceResult } from "@shared/device/protocol.ts";

export const LIVE_CAPABILITIES = ["browser", "computer"] as const;
export type LiveCapability = (typeof LIVE_CAPABILITIES)[number];

export const LIVE_SOURCES = ["chat", "schedule", "task"] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];

export type LiveStatus =
  | "idle"
  | "running"
  | "asking"
  | "typing"
  | "handover"
  | "stopped"
  | "lost"
  | "finished";

export type StepStatus =
  | "queued"
  | "running"
  | "done"
  | "waiting"
  | "refused"
  | "failed"
  | "stopped"
  | "notRun";

export type LiveError = "privateSuggested" | "fileDialog";

export interface LiveStep {
  command_id: string;
  kind: DeviceCommandKind;
  target: string;
  status: StepStatus;
}

export type LiveDecision = "confirm" | "decline";

export interface LiveAsk {
  command_id: string;
  confirmation_id: string;
  confirmation: LocalConfirmation;
  asked_at: number;
}

export interface LiveState {
  session_id: string | null;
  capability: LiveCapability;
  source: LiveSource;
  target: string;
  status: LiveStatus;
  steps: LiveStep[];
  ask: LiveAsk | null;
  page_changed: boolean;
  injection: boolean;
  screenshot: number;
  error: LiveError | null;
  open: boolean;
}

export const INITIAL_LIVE: LiveState = {
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
};

interface StepRef {
  command_id: string;
  kind: DeviceCommandKind;
  target: string;
}

export type LiveEvent =
  | {
      type: "started";
      session_id: string;
      capability: LiveCapability;
      source: LiveSource;
      target: string;
    }
  | ({ type: "queued" } & StepRef)
  | ({ type: "running" } & StepRef)
  | { type: "result"; command_id: string; result: DeviceResult }
  | {
      type: "asked";
      command_id: string;
      confirmation_id: string;
      confirmation: LocalConfirmation;
      at: number;
    }
  | { type: "handover"; command_id: string }
  | { type: "screenshot" }
  | { type: "injection" }
  | { type: "owner_typing" }
  | { type: "owner_idle" }
  | { type: "device_lost" }
  | { type: "reconnected" }
  | { type: "finished" };

export type LiveCommand =
  | { type: "stop" }
  | { type: "decide"; allow: boolean; now: number }
  | { type: "hand_back" }
  | { type: "close" }
  | { type: "show" };

export type LiveEffect =
  | { kind: "stop" }
  | { kind: "confirm"; confirmation_id: string; decision: LiveDecision }
  | { kind: "hand_back"; command_id: string };

const ACTIVE: readonly LiveStatus[] = ["running", "asking", "typing", "handover"];

export function isActive(state: LiveState): boolean {
  return ACTIVE.includes(state.status);
}

export function stopAvailable(state: LiveState): boolean {
  return isActive(state) || state.status === "lost";
}

export function overlayVisible(state: LiveState): boolean {
  return state.capability === "computer" && isActive(state);
}

export function opensWindow(source: LiveSource): boolean {
  return source !== "schedule";
}

export function pendingAsk(state: LiveState, now: number): LiveAsk | null {
  const ask = state.ask;
  if (state.status !== "asking" || !ask) return null;
  return now < Date.parse(ask.confirmation.deadline_at) ? ask : null;
}

export function askExpiresAt(state: LiveState): number | null {
  return state.status === "asking" && state.ask
    ? Date.parse(state.ask.confirmation.deadline_at)
    : null;
}

function withStep(state: LiveState, step: StepRef, status: StepStatus): LiveStep[] {
  const found = state.steps.some((item) => item.command_id === step.command_id);
  if (!found)
    return [
      ...state.steps,
      { command_id: step.command_id, kind: step.kind, target: step.target, status },
    ];
  return state.steps.map((item) =>
    item.command_id === step.command_id ? { ...item, status } : item,
  );
}

function mark(state: LiveState, commandId: string, status: StepStatus): LiveStep[] {
  return state.steps.map((item) => (item.command_id === commandId ? { ...item, status } : item));
}

function skipQueued(steps: LiveStep[]): LiveStep[] {
  return steps.map((item) => (item.status === "queued" ? { ...item, status: "notRun" } : item));
}

function stopLive(state: LiveState): LiveState {
  if (!stopAvailable(state)) return state;
  return {
    ...state,
    status: "stopped",
    ask: null,
    steps: skipQueued(state.steps).map((item) =>
      item.status === "running" || item.status === "waiting"
        ? { ...item, status: "stopped" }
        : item,
    ),
  };
}

function endLive(state: LiveState, steps: LiveStep[]): LiveState {
  return { ...state, status: "finished", ask: null, page_changed: false, steps: skipQueued(steps) };
}

function applyResult(state: LiveState, commandId: string, result: DeviceResult): LiveState {
  switch (result.status) {
    case "done":
      return { ...state, steps: mark(state, commandId, "done") };
    case "failed":
      return { ...state, steps: mark(state, commandId, "failed") };
    case "confirmation_required":
      return { ...state, steps: mark(state, commandId, "waiting") };
    case "stopped":
      return stopLive(state);
    case "refused":
      if (result.code === "stopped") return stopLive(state);
      if (result.code === "private_address")
        return { ...endLive(state, mark(state, commandId, "refused")), error: "privateSuggested" };
      if (result.code === "blocked_app" && result.detail === FILE_DIALOG_REFUSAL.en)
        return { ...state, steps: mark(state, commandId, "refused"), error: "fileDialog" };
      if (result.code === "stale" && state.ask?.command_id === commandId)
        return { ...state, page_changed: true };
      return { ...state, steps: mark(state, commandId, "refused") };
  }
}

export function reduceLive(state: LiveState, event: LiveEvent): LiveState {
  if (event.type === "started")
    return {
      ...INITIAL_LIVE,
      session_id: event.session_id,
      capability: event.capability,
      source: event.source,
      target: event.target,
      status: "running",
      open: opensWindow(event.source),
    };
  if (state.status === "idle") return state;
  switch (event.type) {
    case "screenshot":
      return { ...state, screenshot: state.screenshot + 1 };
    case "injection":
      return { ...state, injection: true };
    case "reconnected":
      return state.status === "lost"
        ? { ...state, status: state.ask ? "asking" : "running" }
        : state;
    case "owner_idle":
      return state.status === "typing" ? { ...state, status: "running" } : state;
    case "owner_typing":
      return state.status === "running" ? { ...state, status: "typing" } : state;
  }
  if (event.type === "finished")
    return isActive(state) || state.status === "lost" ? endLive(state, state.steps) : state;
  if (!isActive(state)) return state;
  switch (event.type) {
    case "queued":
      return state.steps.some((item) => item.command_id === event.command_id)
        ? state
        : { ...state, steps: withStep(state, event, "queued") };
    case "running":
      return { ...state, steps: withStep(state, event, "running") };
    case "result":
      return applyResult(state, event.command_id, event.result);
    case "asked":
      return {
        ...state,
        status: "asking",
        ask: {
          command_id: event.command_id,
          confirmation_id: event.confirmation_id,
          confirmation: event.confirmation,
          asked_at: event.at,
        },
        steps: mark(state, event.command_id, "waiting"),
      };
    case "handover":
      return { ...state, status: "handover", steps: mark(state, event.command_id, "waiting") };
    case "device_lost":
      return { ...state, status: "lost" };
  }
}

export function reduceLiveAll(state: LiveState, events: readonly LiveEvent[]): LiveState {
  return events.reduce(reduceLive, state);
}

export function decideLive(
  state: LiveState,
  command: LiveCommand,
): { state: LiveState; effects: LiveEffect[] } {
  switch (command.type) {
    case "stop": {
      const next = stopLive(state);
      return { state: next, effects: next === state ? [] : [{ kind: "stop" }] };
    }
    case "close":
      return { state: { ...state, open: false }, effects: [] };
    case "show":
      return { state: { ...state, open: state.status !== "idle" }, effects: [] };
    case "hand_back": {
      const waiting = state.steps.find((item) => item.status === "waiting");
      if (state.status !== "handover" || !waiting) return { state, effects: [] };
      return {
        state: { ...state, status: "running", steps: mark(state, waiting.command_id, "running") },
        effects: [{ kind: "hand_back", command_id: waiting.command_id }],
      };
    }
    case "decide": {
      const ask = pendingAsk(state, command.now);
      if (!ask) return { state, effects: [] };
      const effects: LiveEffect[] = [
        {
          kind: "confirm",
          confirmation_id: ask.confirmation_id,
          decision: command.allow ? "confirm" : "decline",
        },
      ];
      if (!command.allow)
        return { state: endLive(state, mark(state, ask.command_id, "refused")), effects };
      return {
        state: {
          ...state,
          status: "running",
          ask: null,
          page_changed: false,
          steps: mark(state, ask.command_id, "running"),
        },
        effects,
      };
    }
  }
}

export function askRows(confirmation: LocalConfirmation, label: string): [string, string][] {
  return [[label, confirmation.target]];
}

export interface LiveSnapshot extends LiveState {
  stoppable: boolean;
  overlay: boolean;
}

export function liveSnapshot(state: LiveState, now: number): LiveSnapshot {
  return {
    ...state,
    ask: pendingAsk(state, now),
    stoppable: stopAvailable(state),
    overlay: overlayVisible(state),
  };
}
