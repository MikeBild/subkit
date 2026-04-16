// `subkit mcp` — stdio MCP server that proxies tool calls through to a
// remote engine. For now this is a minimal stdio server that exposes a
// single `ping` tool so IDE clients can validate the transport. The
// full proxy wiring lands in a later phase.

import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";

export const mcpCommand = defineCommand({
  meta: { name: "mcp", description: "Stdio MCP server proxying a remote engine" },
  args: clientArgs,
  async run({ args }) {
    const { client, engine_url } = makeClient(args as Record<string, unknown>);
    void client;
    // Lazy import so the MCP SDK never gets pulled into a normal CLI run.
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
      "@modelcontextprotocol/sdk/types.js"
    );

    const server = new Server(
      { name: "subkit-cli", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ping",
          description: `Ping the subkit engine at ${engine_url}`,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "ping") {
        return {
          content: [{ type: "text", text: `engine=${engine_url} ok` }],
        };
      }
      return { content: [{ type: "text", text: "unknown tool" }], isError: true };
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
  },
});
