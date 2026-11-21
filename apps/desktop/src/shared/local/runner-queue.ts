import type { DeviceCommand, DeviceRefusal, DeviceResult } from "@shared/device/protocol.ts";

export interface QueueState {
  readonly generation: number;
  readonly pending: readonly DeviceCommand[];
  readonly running: DeviceCommand | null;
}

export interface Settled {
  readonly command_id: string;
  readonly result: DeviceResult;
}

export function emptyQueue(generation = 0): QueueState {
  return { generation, pending: [], running: null };
}

export function refusal(code: DeviceRefusal, detail: string): DeviceResult {
  return { status: "refused", code, detail };
}

function expired(command: DeviceCommand, now: number): boolean {
  return Date.parse(command.deadline_at) <= now;
}

function known(state: QueueState, commandId: string): boolean {
  return (
    state.running?.command_id === commandId ||
    state.pending.some((item) => item.command_id === commandId)
  );
}

export function admit(
  state: QueueState,
  command: DeviceCommand,
  now: number,
): { state: QueueState; settled: Settled | null } {
  if (command.generation < state.generation) {
    return {
      state,
      settled: {
        command_id: command.command_id,
        result: refusal("stopped", "The run was stopped on this device."),
      },
    };
  }
  if (expired(command, now)) {
    return {
      state,
      settled: {
        command_id: command.command_id,
        result: refusal("deadline_passed", "The command reached its deadline before it started."),
      },
    };
  }
  if (known(state, command.command_id)) return { state, settled: null };
  return {
    state: {
      ...state,
      generation: Math.max(state.generation, command.generation),
      pending: [...state.pending, command],
    },
    settled: null,
  };
}

export function stop(state: QueueState, atLeast = 0): { state: QueueState; settled: Settled[] } {
  const settled = state.pending.map((command) => ({
    command_id: command.command_id,
    result: { status: "stopped" } as DeviceResult,
  }));
  return {
    state: {
      generation: Math.max(state.generation + 1, atLeast),
      pending: [],
      running: state.running,
    },
    settled,
  };
}

export function take(
  state: QueueState,
  now: number,
): { state: QueueState; command: DeviceCommand | null; settled: Settled[] } {
  if (state.running) return { state, command: null, settled: [] };
  const settled: Settled[] = [];
  const rest = [...state.pending];
  while (rest.length > 0) {
    const next = rest.shift() as DeviceCommand;
    if (next.generation < state.generation) {
      settled.push({ command_id: next.command_id, result: { status: "stopped" } });
      continue;
    }
    if (expired(next, now)) {
      settled.push({
        command_id: next.command_id,
        result: refusal("deadline_passed", "The command reached its deadline before it started."),
      });
      continue;
    }
    return { state: { ...state, pending: rest, running: next }, command: next, settled };
  }
  return { state: { ...state, pending: [] }, command: null, settled };
}

export function cancel(
  state: QueueState,
  commandId: string,
): { state: QueueState; settled: Settled | null } {
  const index = state.pending.findIndex((item) => item.command_id === commandId);
  if (index === -1) return { state, settled: null };
  return {
    state: { ...state, pending: state.pending.filter((_, at) => at !== index) },
    settled: { command_id: commandId, result: { status: "stopped" } },
  };
}

export function finish(
  state: QueueState,
  commandId: string,
  result: DeviceResult,
): { state: QueueState; settled: Settled | null } {
  if (state.running?.command_id !== commandId) return { state, settled: null };
  return { state: { ...state, running: null }, settled: { command_id: commandId, result } };
}

export function isStopped(state: QueueState, command: DeviceCommand): boolean {
  return command.generation < state.generation;
}
