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
    user_agent: `subkit-cli/${VERSION} (mcp)`,
  });

  const server = new Server(
    { name: "subkit-cli", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "subkit_ping",
        title: "subkit_ping",
        description: `Ping the engine at ${profile.engine_url} and return its health status.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execution: { taskSupport: "forbidden" },
      },
      {
        name: "subkit_conversation_create",
        title: "subkit_conversation_create",
        description:
          "Create a new conversation and optionally drive the first turn. intake_item_ids starts a selected clip review; inspect and prepare it here, then use authenticated Cockpit for a person's final knowledge confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            initial_message: { type: "string" },
            memory: { type: "string" },
            connector_id: { type: "string" },
            workflow_id: { type: "string" },
            model: { type: "string" },
            title: { type: "string" },
            intake_item_ids: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "string",
                pattern:
                  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
              },
            },
          },
          additionalProperties: false,
        },
        execution: { taskSupport: "forbidden" },
      },
      {
        name: "subkit_conversation_append",
        title: "subkit_conversation_append",
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
        name: "subkit_conversation_get",
        title: "subkit_conversation_get",
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
        name: "subkit_conversation_list",
        title: "subkit_conversation_list",
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
      if (name === "subkit_ping") {
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
      if (name === "subkit_conversation_create") {
        const intakeItemIds = args.intake_item_ids;
        if (
          intakeItemIds !== undefined &&
          (!Array.isArray(intakeItemIds) ||
            intakeItemIds.length === 0 ||
            intakeItemIds.length > 100 ||
            intakeItemIds.some(
              (id) =>
                typeof id !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                  id,
                ),
            ))
        ) {
          throw new Error("intake_item_ids must contain 1 to 100 UUIDs");
        }
        const created = await client.createConversation({
          ...(typeof args.initial_message === "string"
            ? { initial_message: args.initial_message }
            : {}),
          ...(typeof args.memory === "string" ? { memory: args.memory } : {}),
          ...(typeof args.connector_id === "string" ? { connector_id: args.connector_id } : {}),
          ...(typeof args.workflow_id === "string" ? { workflow_id: args.workflow_id } : {}),
          ...(typeof args.model === "string" ? { model: args.model } : {}),
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          ...(intakeItemIds ? { intake_item_ids: intakeItemIds } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
      }
      if (name === "subkit_conversation_append") {
        const convId = String(args.conversation_id);
        const message = String(args.message);
        const out = await client.appendConversationMessage(convId, {
          message,
          ...(typeof args.memory === "string" ? { memory: args.memory } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      if (name === "subkit_conversation_get") {
        const convId = String(args.conversation_id);
        const detail = await client.getConversation(convId);
        return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
      }
      if (name === "subkit_conversation_list") {
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
            text: `subkit mcp error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
