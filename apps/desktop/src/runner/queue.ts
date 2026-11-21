import type { DeviceCommand, DeviceResult } from "@shared/device/protocol.ts";
import {
  admit,
  cancel,
  emptyQueue,
  finish,
  type QueueState,
  type Settled,
  stop,
  take,
} from "../shared/local/runner-queue.ts";

export type Execute = (command: DeviceCommand, signal: AbortSignal) => Promise<DeviceResult>;

export interface RunnerQueueOptions {
  generation?: number;
  execute: Execute;
  settle: (settled: Settled) => void;
  now: () => number;
}

export interface RunnerQueue {
  submit(command: DeviceCommand): void;
  cancel(commandId: string): void;
  stop(atLeast?: number): void;
  generation(): number;
  idle(): Promise<void>;
}

function failure(error: unknown): DeviceResult {
  return {
    status: "failed",
    code: "runner_error",
    detail: error instanceof Error ? error.message : "The command failed on this device.",
  };
}

export function createRunnerQueue(options: RunnerQueueOptions): RunnerQueue {
  let state: QueueState = emptyQueue(options.generation ?? 0);
  let current: AbortController | null = null;
  let running: Promise<void> = Promise.resolve();

  const pump = () => {
    const next = take(state, options.now());
    state = next.state;
    for (const item of next.settled) options.settle(item);
    const command = next.command;
    if (!command) return;
    const controller = new AbortController();
    current = controller;
    const remaining = Math.max(0, Date.parse(command.deadline_at) - options.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    running = options
      .execute(command, controller.signal)
      .catch(failure)
      .then((result) => {
        clearTimeout(timer);
        current = null;
        const done = finish(state, command.command_id, result);
        state = done.state;
        if (done.settled) options.settle(done.settled);
        pump();
      });
  };

  return {
    submit(command) {
      const next = admit(state, command, options.now());
      state = next.state;
      if (next.settled) options.settle(next.settled);
      pump();
    },
    cancel(commandId) {
      if (state.running?.command_id === commandId) {
        current?.abort();
        return;
      }
      const next = cancel(state, commandId);
      state = next.state;
      if (next.settled) options.settle(next.settled);
    },
    stop(atLeast = 0) {
      const next = stop(state, atLeast);
      state = next.state;
      current?.abort();
      for (const item of next.settled) options.settle(item);
    },
    generation: () => state.generation,
    idle: () => running,
  };
}
