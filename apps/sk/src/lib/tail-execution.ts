// Shared live-follow over GET /v1/executions/{id}/stream.
//
// Used by `sk executions tail <id>` and `sk workflows run <id> --follow`.
// Each SSE frame becomes one JSON line on stdout —
// `{"type":"execution.step.started","step_key":"fetch",...}` — so the
// same output is human-greppable in a terminal and machine-parseable
// when piped (`--follow | jq .type`). The engine closes the stream
// right after the terminal frame, so this resolves on its own for
// finished runs.

import { readSse } from "@cli-core/sse.ts";
import type { EngineClient } from "../engine-client.ts";

const TERMINAL_EVENTS = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.aborted",
  "execution.timed_out",
]);

/**
 * Stream an execution's event frames to `out` until the engine closes
 * the stream. Returns the terminal status ("succeeded" | "failed" |
 * "aborted" | "timed_out") or null when the stream ended without one
 * (client abort / engine restart).
 */
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

/** Exit-code mapping for a followed run: success → 0, anything else → 1. */
export function exitCodeForTerminalStatus(status: string | null): number {
  return status === "succeeded" ? 0 : 1;
}
