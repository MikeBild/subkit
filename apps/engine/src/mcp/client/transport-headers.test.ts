import { describe, expect, test } from "bun:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpRequestHeaders } from "./session.ts";

describe("requests to an external MCP server", () => {
  test("ask for an uncompressed answer and keep the connector's own headers", () => {
    expect(mcpRequestHeaders({ authorization: "Bearer token" })).toEqual({
      authorization: "Bearer token",
      "accept-encoding": "identity",
    });
    expect(mcpRequestHeaders({ "accept-encoding": "gzip" })["accept-encoding"]).toBe("identity");
  });

  test("the wire carries identity, so a cut-off compressed stream never reaches the decompressor", async () => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("accept-encoding"));
        return Response.json({ jsonrpc: "2.0", id: 0, result: {} });
      },
    });
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
        { requestInit: { headers: mcpRequestHeaders({}) } },
      );
      await transport.start();
      await transport.send({ jsonrpc: "2.0", id: 0, method: "ping" });
      await transport.close();
    } finally {
      server.stop(true);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["identity"]));
  });
});
