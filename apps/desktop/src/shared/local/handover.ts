import type { DeviceResult } from "@shared/device/protocol.ts";

export interface HandoverWait<T> {
  readonly command_id: string;
  readonly waiter: T;
}

export interface HandoverState<T> {
  readonly waiting: readonly HandoverWait<T>[];
}

export type HandoverEvent<T> =
  | { readonly type: "begin"; readonly command_id: string; readonly waiter: T }
  | { readonly type: "hand_back"; readonly command_id: string }
  | { readonly type: "abort"; readonly command_id: string }
  | { readonly type: "stop" };

export type HandoverOutcome = "handed_back" | "stopped";

export interface HandoverSettled<T> {
  readonly waiter: T;
  readonly outcome: HandoverOutcome;
}

export interface HandoverStep<T> {
  readonly state: HandoverState<T>;
  readonly settled: readonly HandoverSettled<T>[];
}

function settle<T>(
  state: HandoverState<T>,
  command_id: string,
  outcome: HandoverOutcome,
): HandoverStep<T> {
  return {
    state: { waiting: state.waiting.filter((wait) => wait.command_id !== command_id) },
    settled: state.waiting
      .filter((wait) => wait.command_id === command_id)
      .map((wait) => ({ waiter: wait.waiter, outcome })),
  };
}

export function stepHandover<T>(state: HandoverState<T>, event: HandoverEvent<T>): HandoverStep<T> {
  switch (event.type) {
    case "begin":
      return state.waiting.some((wait) => wait.command_id === event.command_id)
        ? { state, settled: [] }
        : {
            state: {
              waiting: [...state.waiting, { command_id: event.command_id, waiter: event.waiter }],
            },
            settled: [],
          };
    case "hand_back":
      return settle(state, event.command_id, "handed_back");
    case "abort":
      return settle(state, event.command_id, "stopped");
    case "stop":
      return {
        state: { waiting: [] },
        settled: state.waiting.map((wait) => ({
          waiter: wait.waiter,
          outcome: "stopped" as const,
        })),
      };
  }
}

export function handoverResult(outcome: HandoverOutcome): DeviceResult {
  return outcome === "stopped"
    ? { status: "stopped" }
    : { status: "done", output: { handed_back: true }, evidence: {} };
}
