// `sk mcp` — stdio MCP server that proxies the most-used `sk` surfaces
// (start a conversation, append a turn, fetch detail) through to a
// remote engine. Mirrors the pattern from
// `apps/cli/src/commands/mcp.ts` but exposes sk-specific tools so IDE
// plugins can drive the end-user CLI without ever invoking it.
//
// The MCP SDK imports are lazy so users running `sk -p "..."` never
// pay for the MCP module tree.

import { VERSION } from "@cli-core/version.ts";
import type { ResolvedProfile } from "./config.ts";
import { EngineClient } from "./engine-client.ts";

export async function runMcpProxy(profile: ResolvedProfile): Promise<void> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const client = new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
    user_agent: `sk-cli/${VERSION} (mcp)`,
  });

  const server = new Server({ name: "sk-cli", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "sk.ping",
        description: `Ping the engine at ${profile.engine_url} and return its health status.`,
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "sk.conversation.create",
        description: "Create a new conversation and optionally drive the first turn.",
        inputSchema: {
          type: "object",
          properties: {
            initial_message: { type: "string" },
            memory: { type: "string" },
            connector_id: { type: "string" },
            workflow_id: { type: "string" },
            model: { type: "string" },
            title: { type: "string" },
          },
        },
      },
      {
        name: "sk.conversation.append",
        description: "Append a user message to an existing conversation and drive another turn.",
        inputSchema: {
          type: "object",
          required: ["conversation_id", "message"],
          properties: {
            conversation_id: { type: "string" },
            message: { type: "string" },
            memory: { type: "string" },
          },
        },
      },
      {
        name: "sk.conversation.get",
        description: "Fetch a conversation detail (messages, tool calls, draft, approvals).",
        inputSchema: {
          type: "object",
          required: ["conversation_id"],
          properties: { conversation_id: { type: "string" } },
        },
      },
      {
        name: "sk.conversation.list",
        description: "List conversations owned by the caller (owner=me).",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "sk.ping") {
        const h = await client.health();
        return {
          content: [
            {
              type: "text",
              text: `engine=${profile.engine_url} status=${h.status} db=${h.db_connected}`,
            },
          ],
        };
      }
      if (name === "sk.conversation.create") {
        const created = await client.createConversation({
          ...(typeof args.initial_message === "string"
            ? { initial_message: args.initial_message }
            : {}),
          ...(typeof args.memory === "string" ? { memory: args.memory } : {}),
          ...(typeof args.connector_id === "string" ? { connector_id: args.connector_id } : {}),
          ...(typeof args.workflow_id === "string" ? { workflow_id: args.workflow_id } : {}),
          ...(typeof args.model === "string" ? { model: args.model } : {}),
          ...(typeof args.title === "string" ? { title: args.title } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
      }
      if (name === "sk.conversation.append") {
        const convId = String(args.conversation_id);
        const message = String(args.message);
        const out = await client.appendConversationMessage(convId, {
          message,
          ...(typeof args.memory === "string" ? { memory: args.memory } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      if (name === "sk.conversation.get") {
        const convId = String(args.conversation_id);
        const detail = await client.getConversation(convId);
        return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
      }
      if (name === "sk.conversation.list") {
        const limit = typeof args.limit === "number" ? args.limit : 20;
        const res = await client.listConversations({ owner: "me", limit });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `sk mcp error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
