import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "stdio-echo", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Echo the given text", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

server.registerTool("env_dump", { description: "List the environment" }, async () => ({
  content: [{ type: "text", text: JSON.stringify(Bun.env) }],
}));

process.stderr.write(
  `stdio-echo ready pat=ghp_abcdefghijklmnopqrstuvwxyz0123456789 secret=${Bun.env.FIXTURE_SECRET ?? ""}\n`,
);
await server.connect(new StdioServerTransport());
