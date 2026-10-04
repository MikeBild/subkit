import { readSse } from "@cli-core/sse.ts";
import type { EngineClient } from "../engine-client.ts";

const TERMINAL_EVENTS = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.refused",
  "execution.aborted",
  "execution.timed_out",
]);

export async function tailExecution(
  client: EngineClient,
  executionId: string,
  out: { write: (s: string) => unknown } = process.stdout,
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
    if (TERMINAL_EVENTS.has(frame.event)) {
      terminal = frame.event.slice("execution.".length);
    }
  });
  return terminal;
}

export function exitCodeForTerminalStatus(status: string | null): number {
  return status === "succeeded" ? 0 : 1;
}
