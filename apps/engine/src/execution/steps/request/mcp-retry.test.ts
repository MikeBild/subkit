import { describe, expect, test } from "bun:test";
import type { McpInvokeResult } from "../../../connectors/drivers/mcp.ts";
import type { ConnectorResolutionSummary } from "../../types.ts";
import { runMcpWithRetry } from "./mcp-retry.ts";

const timedOut = (effect: "read" | "write"): McpInvokeResult => ({
  ok: false,
  content: { error: "Request timed out" },
  bytes: 0,
  failure: "timeout",
  effect,
  wire_method: "tools/call",
  tool_name: "acme__create_invoice",
});

function run(effect: "read" | "write") {
  let attempts = 0;
  const outcome = runMcpWithRetry({
    attempt: async () => {
      attempts++;
      return timedOut(effect);
    },
    step: { max_retries: 2, retry_backoff_ms: 0 },
    signal: new AbortController().signal,
    start: 0,
    clock: { now: () => 0 } as never,
    connector: {} as ConnectorResolutionSummary,
    operation: "tools/call",
    connector_id: "connector-1",
  });
  return outcome.then((result) => ({ result, attempts }));
}

describe("a timed-out MCP call", () => {
  test("to a write tool is not sent again and asks to check the target", async () => {
    const { result, attempts } = await run("write");
    expect(attempts).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("mcp_timeout_during_write");
    expect(result.error?.message).toContain("acme__create_invoice");
    expect(result.error?.guidance).toBe(
      "Check in the target system whether the change arrived before you run it again.",
    );
  });

  test("to a read-only tool keeps its retries", async () => {
    const { result, attempts } = await run("read");
    expect(attempts).toBe(3);
    expect(result.error?.code).toBe("mcp_unavailable");
  });
});
