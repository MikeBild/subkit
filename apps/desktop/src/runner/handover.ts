import { BrowserHandoverArgsSchema } from "@shared/device/browser.ts";
import { ComputerHandoverArgsSchema } from "@shared/device/computer.ts";
import type { DeviceCommand, DeviceResult } from "@shared/device/protocol.ts";
import {
  type HandoverEvent,
  type HandoverOutcome,
  type HandoverState,
  handoverResult,
  stepHandover,
} from "../shared/local/handover.ts";
import type { LiveProgress } from "../shared/local/live-progress.ts";
import type { DeviceAdapter } from "./adapter.ts";

type Waiter = (outcome: HandoverOutcome) => void;

export interface Handover {
  readonly adapter: DeviceAdapter;
  handBack(commandId: string): void;
  stop(): void;
}

export function createHandover(
  version: string,
  progress: (command: DeviceCommand, progress: LiveProgress) => void,
): Handover {
  let state: HandoverState<Waiter> = { waiting: [] };
  const apply = (event: HandoverEvent<Waiter>) => {
    const step = stepHandover(state, event);
    state = step.state;
    for (const settled of step.settled) settled.waiter(settled.outcome);
  };
  return {
    adapter: {
      name: "handover",
      version,
      kinds: ["browser.handover", "computer.handover"],
      execute(command, signal): Promise<DeviceResult> {
        const schema =
          command.kind === "browser.handover"
            ? BrowserHandoverArgsSchema
            : ComputerHandoverArgsSchema;
        const parsed = schema.safeParse(command.args);
        if (!parsed.success)
          return Promise.resolve({
            status: "failed",
            code: "invalid_args",
            detail: "The handover is not valid.",
          });
        if (signal.aborted) return Promise.resolve(handoverResult("stopped"));
        return new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            apply({ type: "abort", command_id: command.command_id }),
          );
          apply({
            type: "begin",
            command_id: command.command_id,
            waiter: (outcome) => resolve(handoverResult(outcome)),
          });
          progress(command, { type: "running", target: parsed.data.reason });
          progress(command, { type: "handover" });
        });
      },
    },
    handBack: (commandId) => apply({ type: "hand_back", command_id: commandId }),
    stop: () => apply({ type: "stop" }),
  };
}
