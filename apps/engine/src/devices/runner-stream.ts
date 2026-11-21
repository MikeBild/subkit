import type { Db } from "../db/client.ts";
import { globalEmitter } from "../pubsub/emitter.ts";
import { pendingCommandIds } from "./channel.ts";
import { type RunnerIdentity, runnerStanding } from "./runner-auth.ts";

const STREAM_PING_MS = 25_000;
const CLOSED_FOR_RUNNER = new Set(["stopped", "cancelled", "expired", "lost", "revoked"]);

export type RunnerFrame =
  | { event: "command.available" | "command.cancelled"; command_id: string }
  | { event: "runner.revoked" | "ping" };

export function runnerFrame(
  runner: Pick<RunnerIdentity, "tenant_id" | "device_id">,
  event: { tenant_id: string; type: string; payload: unknown },
): RunnerFrame | "check_revoked" | null {
  if (event.tenant_id !== runner.tenant_id) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (payload.device_id !== runner.device_id) return null;
  if (event.type === "device.offline") return "check_revoked";
  if (event.type !== "device.command" || typeof payload.command_id !== "string") return null;
  if (payload.command_state === "pending")
    return { event: "command.available", command_id: payload.command_id };
  if (typeof payload.command_state === "string" && CLOSED_FOR_RUNNER.has(payload.command_state))
    return { event: "command.cancelled", command_id: payload.command_id };
  return null;
}

export async function streamRunnerFrames(
  db: Db,
  runner: RunnerIdentity,
  signal: AbortSignal,
  write: (frame: RunnerFrame) => Promise<void>,
): Promise<void> {
  const frames: (RunnerFrame | "check_revoked")[] = [];
  let wake: (() => void) | null = null;
  const off = globalEmitter.on("resource.lifecycle", (event) => {
    const frame = runnerFrame(runner, event);
    if (!frame) return;
    frames.push(frame);
    wake?.();
  });
  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort);
  try {
    for (const command_id of await pendingCommandIds(db, runner))
      await write({ event: "command.available", command_id });
    while (!signal.aborted) {
      const frame = frames.shift();
      if (frame === "check_revoked") {
        if ((await runnerStanding(db, runner.device_id)).ok) continue;
        await write({ event: "runner.revoked" });
        return;
      }
      if (frame) {
        await write(frame);
        continue;
      }
      const quiet = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), STREAM_PING_MS);
        wake = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      wake = null;
      if (quiet && !signal.aborted) await write({ event: "ping" });
    }
  } finally {
    off();
    signal.removeEventListener("abort", onAbort);
  }
}
