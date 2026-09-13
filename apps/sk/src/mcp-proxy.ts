// `sk mcp` — stdio MCP server that proxies the most-used `sk` surfaces
// (start a conversation, append a turn, fetch detail) through to a
// remote engine. Exposes sk-specific tools so IDE plugins can drive
// the CLI-facing conversation surface without ever invoking the TUI.
//
// The MCP SDK imports are lazy so users running `sk -p "..."` never
// pay for the MCP module tree.

import { VERSION } from "@cli-core/version.ts";

import type { ResolvedProfile } from "./config.ts";
import { EngineClient } from "./engine-client.ts";

export async function runMcpProxy(profile: ResolvedProfile): Promise<void> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");

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
        name: "sk_ping",
        title: "sk_ping",
        description: `Ping the engine at ${profile.engine_url} and return its health status.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execution: { taskSupport: "forbidden" },
      },
      {
        name: "sk_conversation_create",
        title: "sk_conversation_create",
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
          additionalProperties: false,
        },
        execution: { taskSupport: "forbidden" },
      },
      {
        name: "sk_conversation_append",
        title: "sk_conversation_append",
        description: "Append a user message to an existing conversation and drive another turn.",
        inputSchema: {
          type: "object",
          required: ["conversation_id", "message"],
          properties: {
            conversation_id: { type: "string" },
            message: { type: "string" },
            memory: { type: "string" },
          },
          additionalProperties: false,
        },
        execution: { taskSupport: "forbidden" },
      },
      {
        name: "sk_conversation_get",
        title: "sk_conversation_get",
        description: "Fetch a conversation detail (messages, call history, draft, approvals).",
        inputSchema: {
          type: "object",
          required: ["conversation_id"],
          properties: { conversation_id: { type: "string" } },
          additionalProperties: false,
        },
        execution: { taskSupport: "forbidden" },
      },
      {
        name: "sk_conversation_list",
        title: "sk_conversation_list",
        description: "List conversations owned by the caller (owner=me).",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
          additionalProperties: false,
        },
        execution: { taskSupport: "forbidden" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "sk_ping") {
        const [h, ready] = await Promise.all([client.health(), client.ready()]);
        return {
          content: [
            {
              type: "text",
              text: `engine=${profile.engine_url} live=${h.status} ready=${ready.status} database=${ready.checks.database}`,
            },
          ],
        };
      }
      if (name === "sk_conversation_create") {
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
      if (name === "sk_conversation_append") {
        const convId = String(args.conversation_id);
        const message = String(args.message);
        const out = await client.appendConversationMessage(convId, {
          message,
          ...(typeof args.memory === "string" ? { memory: args.memory } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      if (name === "sk_conversation_get") {
        const convId = String(args.conversation_id);
        const detail = await client.getConversation(convId);
        return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
      }
      if (name === "sk_conversation_list") {
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
