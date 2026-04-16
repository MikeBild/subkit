import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("progress");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp tools/call progress notifications", () => {
  test("emits at least one progress frame for a slow workflow", async () => {
    // Seed a workflow with a handful of wait steps so the poller has
    // time to catch multiple inserts into execution_steps.
    await suite.seedWorkflow({
      name: "slow",
      slug: "slow-probe",
      steps: [
        { kind: "wait", id: "a", duration_ms: 300 },
        { kind: "wait", id: "b", duration_ms: 300 },
        { kind: "wait", id: "c", duration_ms: 300 },
      ],
    });

    const client = await suite.connect();
    const frames: Array<{
      progress: number;
      total?: number | undefined;
      message?: string | undefined;
    }> = [];
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "wf.slow-probe",
          arguments: {},
        },
      },
      CallToolResultSchema,
      {
        onprogress: (p) => {
          frames.push(p);
        },
        // Slightly more generous timeout than the default because the
        // workflow itself runs ~900 ms.
        timeout: 30_000,
      },
    );
    expect(result.isError).toBeFalsy();
    // We expect at least one intermediate progress frame plus the final
    // 1.0 completion frame.
    process.stderr.write(
      `mcp.progress.frames count=${frames.length} frames=${JSON.stringify(frames)}\n`,
    );
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const last = frames[frames.length - 1]!;
    expect(last.total).toBe(1);
    expect(typeof last.progress).toBe("number");
  }, 60_000);
});
