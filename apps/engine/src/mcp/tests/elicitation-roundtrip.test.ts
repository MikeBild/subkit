// MCP elicitation round-trip — over the real streamable-HTTP transport.
//
// What this test pins, and why it exists:
//
// The streamable-HTTP transport runs with `enableJsonResponse: false`
// (see `transports/streamable-http.ts`) precisely so a tool whose
// `execute` issues a server→client `elicitation/create` request
// mid-`tools/call` can flush that request on the still-open SSE stream.
// Every OTHER test in this suite either uses a stub `Server`
// (`elicitation/bridge.test.ts`) or a non-elicitation client
// (`streamable-http-sse-smoke.test.ts`) — none proves an actual
// `elicitation/create` request reaches an elicitation-capable client and
// the answer flows back over the wire.
//
// This test closes that gap at the narrowest level that still exercises
// the load-bearing surface:
//
//   - a REAL `WebStandardStreamableHTTPServerTransport` with the same
//     `enableJsonResponse: false` flag the production mount uses,
//   - the REAL `createElicitationBridge` factory + `ElicitationBridge`
//     class issuing `elicitForm` mid-`tools/call`,
//   - a REAL MCP SDK `Client` advertising `capabilities.elicitation` and
//     answering via a `setRequestHandler(ElicitRequestSchema, …)`.
//
// Driving the full `conversation_start` loop would require mocking the
// LLM; that is deliberately avoided. Instead a single test-only tool is
// registered on a bare `Server` whose `tools/call` handler builds the
// production bridge and calls it — so the bridge → transport → client
// `elicitation/create` round-trip is genuinely exercised end to end,
// deterministically, with no LLM and no external network.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ServerType, serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createElicitationBridge } from "../elicitation/bridge.ts";

interface RoundTripHarness {
  baseUrl: string;
  close: () => Promise<void>;
}

// Stand up a bare MCP `Server` whose single test tool, mid-`tools/call`,
// constructs the PRODUCTION `ElicitationBridge` via `createElicitationBridge`
// and issues a form elicitation. The server is mounted on the real
// `WebStandardStreamableHTTPServerTransport` (same `enableJsonResponse:
// false` as the production `/mcp` mount) and served over `Bun.serve`.
function startRoundTripServer(): RoundTripHarness {
  const sessions = new Map<
    string,
    { transport: WebStandardStreamableHTTPServerTransport; server: Server }
  >();

  const buildServer = (): Server => {
    const server = new Server(
      { name: "elicitation-roundtrip-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "elicit_probe",
          description: "Issues a form elicitation mid-tool-call.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      // The load-bearing line: the PRODUCTION bridge factory, fed the real
      // `Server` + per-request `extra`, issues a server→client
      // `elicitation/create` on the still-open `tools/call` SSE stream.
      const bridge = createElicitationBridge(server, extra);
      const result = await bridge.elicitForm({
        message: "Confirm the round-trip.",
        requestedSchema: {
          type: "object",
          properties: {
            acknowledged: { type: "boolean", title: "Acknowledged" },
          },
          required: ["acknowledged"],
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    });

    return server;
  };

  // Mount the transport behind a Hono `.all("/mcp", …)` handler served by
  // `@hono/node-server` — the SAME server stack the production HTTP test
  // harness uses. The transport returns a Web-standard `Response`;
  // `@hono/node-server` adapts it to the Node `http.Server` exactly as the
  // real `/mcp` mount does. (Serving the transport's response on a raw
  // `Bun.serve` handler is rejected once a co-resident test has loaded the
  // Node HTTP shim — a harness wrinkle, not the surface under test.)
  const app = new Hono();
  app.all("/mcp", async (c): Promise<Response> => {
    const req = c.req.raw;
    const sessionHeader = req.headers.get("mcp-session-id");
    let session = sessionHeader ? sessions.get(sessionHeader) : undefined;
    if (!session) {
      const server = buildServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: createDeterministicUuidFactory(0x5e551),
        // Same flag as the production `/mcp` mount — a mid-tool-call
        // `elicitation/create` needs the POST's SSE stream held open.
        enableJsonResponse: false,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server });
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
        },
      });
      await server.connect(transport);
      session = { transport, server };
    }
    return session.transport.handleRequest(req);
  });

  const httpServer: ServerType = serve({ fetch: app.fetch, port: 0 });
  const addr = (httpServer as unknown as { address: () => { port: number } | null }).address();
  if (!addr) throw new Error("failed to determine round-trip server port");

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      // Close the transports first (drops any held SSE stream), then the
      // servers — ordering this way keeps `server.close()` from blocking
      // on a still-open stream.
      for (const { transport, server } of sessions.values()) {
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
        try {
          await server.close();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => {
        (httpServer as unknown as { close: (cb: () => void) => void }).close(() => resolve());
      });
    },
  };
}

let harness: RoundTripHarness;

beforeAll(() => {
  harness = startRoundTripServer();
});

afterAll(async () => {
  await harness.close();
});

describe("MCP elicitation round-trip — server→client elicitation/create over streamable-HTTP", () => {
  test("a mid-tool-call elicitation reaches an elicitation-capable client and the answer flows back", async () => {
    // A REAL SDK Client advertising the elicitation capability — the
    // bridge derives `capabilities.form` from exactly this advertisement.
    const client = new Client(
      { name: "elicitation-roundtrip-client", version: "0.0.0" },
      { capabilities: { elicitation: {} } },
    );

    let elicitationHandlerInvoked = false;
    let elicitationMessage: string | undefined;
    // The client-side elicitation handler. Receiving this proves the
    // server→client `elicitation/create` traversed the SSE-framed
    // streamable-HTTP transport while the `tools/call` was still in flight.
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationHandlerInvoked = true;
      elicitationMessage = request.params.message;
      return { action: "accept", content: { acknowledged: true } };
    });

    const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`));
    try {
      await client.connect(transport as unknown as Transport);

      const called = await client.callTool({ name: "elicit_probe", arguments: {} });

      // The client's elicitation handler ran mid-tool-call.
      expect(elicitationHandlerInvoked).toBe(true);
      expect(elicitationMessage).toBe("Confirm the round-trip.");

      // The tool result carries the elicitation answer — it flowed back
      // through the bridge → transport → tool-call response.
      expect(called.isError).toBeFalsy();
      const content = called.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      const elicitResult = JSON.parse(content[0]!.text) as {
        action: string;
        content?: { acknowledged?: boolean };
      };
      expect(elicitResult.action).toBe("accept");
      expect(elicitResult.content?.acknowledged).toBe(true);
    } finally {
      await client.close();
    }
  });
});
