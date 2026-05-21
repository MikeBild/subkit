// Streamable-HTTP SSE-framing smoke test.
//
// `transports/streamable-http.ts` sets `enableJsonResponse: false`
// transport-wide: every POST /mcp response — including `initialize` and
// `tools/list` — is delivered as an SSE-framed envelope rather than a
// single buffered JSON body. That switch is REQUIRED so a mid-tool-call
// `elicitation/create` request can be flushed on the still-open stream.
//
// This test pins the other side of that trade-off: a plain,
// non-elicitation MCP client (the SDK's `Client`, which does not
// advertise the elicitation capability) must still deserialize the
// SSE-framed responses correctly for the ordinary `initialize` →
// `tools/list` → `tools/call` path. If the SSE framing ever regresses,
// this fails before any elicitation-specific test does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-sse-smoke");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
});

describe("streamable-http transport — SSE-framed envelope (non-elicitation client)", () => {
  test("initialize → tools/list → tools/call all parse over the SSE-framed transport", async () => {
    await suite.seedWorkflow({
      name: "sse smoke",
      slug: "sse-smoke",
      steps: [
        {
          kind: "request",
          id: "u",
          method: "GET",
          url: `${mock.baseUrl}/ping`,
        },
      ],
    });

    // `connect()` performs the MCP `initialize` handshake over the
    // streamable-HTTP transport. With `enableJsonResponse: false` the
    // initialize response itself is SSE-framed — a successful connect
    // proves the client deserialized that frame.
    const client = await suite.connect();

    // `tools/list` — SSE-framed response, must deserialize into a
    // non-empty catalog including the seeded workflow tool.
    const listed = await client.listTools();
    expect(Array.isArray(listed.tools)).toBe(true);
    expect(listed.tools.length).toBeGreaterThan(0);
    expect(listed.tools.some((t) => t.name === "wf_sse-smoke")).toBe(true);

    // `tools/call` — the response stream stays open for the call and the
    // SSE-framed result deserializes into the workflow output.
    const called = await client.callTool({ name: "wf_sse-smoke", arguments: {} });
    expect(called.isError).toBeFalsy();
    const content = called.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);
    expect(content[0]?.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
