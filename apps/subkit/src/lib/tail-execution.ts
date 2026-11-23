import { readSse } from "@cli-core/sse.ts";
import type { EngineClient } from "../engine-client.ts";
import {
  UNCERTAIN_EVENT,
  UNCERTAIN_STATUS,
  uncertainWriteBlockForExecution,
} from "./uncertain-write.ts";

const TERMINAL_EVENTS = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.refused",
  "execution.aborted",
  "execution.timed_out",
]);

export async function tailExecution(
  client: Pick<EngineClient, "streamExecution">,
  executionId: string,
  out: { write: (s: string) => unknown } = process.stdout,
  onFrame?: (payload: Record<string, unknown>, event: string) => void,
): Promise<string | null> {
  const resp = await client.streamExecution(executionId);
  if (!resp.body) throw new Error("execution stream returned no body");
  let terminal: string | null = null;
  await readSse(resp, (frame) => {
    if (!frame.event || frame.event === "hello") return;
    let payload: Record<string, unknown> = {};
    if (frame.data) {
      try {
        payload = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        payload = { raw: frame.data };
      }
    }
    out.write(`${JSON.stringify({ type: frame.event, ...payload })}\n`);
    onFrame?.(payload, frame.event);
    if (frame.event === UNCERTAIN_EVENT) {
      terminal = UNCERTAIN_STATUS;
      return false;
    }
    if (TERMINAL_EVENTS.has(frame.event)) {
      terminal = frame.event.slice("execution.".length);
    }
    return undefined;
  });
  return terminal;
}

export async function followExecution(
  client: Pick<EngineClient, "streamExecution" | "getExecution" | "executionSteps">,
  executionId: string,
  err: { write: (s: string) => unknown } = process.stderr,
  onFrame?: (payload: Record<string, unknown>, event: string) => void,
): Promise<string | null> {
  let uncertain: Record<string, unknown> | null = null;
  const terminal = await tailExecution(client, executionId, process.stdout, (payload, event) => {
    if (event === UNCERTAIN_EVENT) uncertain = payload;
    onFrame?.(payload, event);
  });
  if (terminal === UNCERTAIN_STATUS)
    err.write(`\n${await uncertainWriteBlockForExecution(client, executionId, uncertain)}\n`);
  return terminal;
}

export function exitCodeForTerminalStatus(status: string | null): number {
  return status === "succeeded" ? 0 : 1;
}
