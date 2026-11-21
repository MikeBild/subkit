import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initialSessionState, type SkSessionState } from "@cli-core/index.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { EngineClient } from "../../../../sk/src/engine-client.ts";
import { handleSlash } from "../../../../sk/src/repl/slash/handler.ts";
import * as conversationsSvc from "../../conversations/service/index.ts";
import { skills } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

describe("the sk terminal chat proxies MCP and answers slash commands", () => {
  describe("the MCP stdio proxy", () => {
    let ctx: JourneyCtx;

    class NoopTransport {
      onmessage?: (msg: unknown) => void;
      onclose?: () => void;
      onerror?: (err: Error) => void;
      async start(): Promise<void> {}
      async send(_msg: unknown): Promise<void> {}
      async close(): Promise<void> {
        this.onclose?.();
      }
    }

    async function buildServer(): Promise<{
      server: Server;
      listTools: () => Promise<unknown>;
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    }> {
      const client = new EngineClient({
        engine_url: ctx.baseUrl,
        api_key: ctx.apiKey,
        tenant: ctx.tenantId,
        user_agent: "sk-cli/0.0.1 (mcp-test)",
      });

      const server = new Server(
        { name: "sk-cli", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "sk.ping", description: "ping", inputSchema: { type: "object", properties: {} } },
          {
            name: "sk.conversation.create",
            description: "create",
            inputSchema: {
              type: "object",
              properties: {
                initial_message: { type: "string" },
                memory: { type: "string" },
              },
            },
          },
          {
            name: "sk.conversation.append",
            description: "append",
            inputSchema: {
              type: "object",
              required: ["conversation_id", "message"],
              properties: {
                conversation_id: { type: "string" },
                message: { type: "string" },
              },
            },
          },
          {
            name: "sk.conversation.get",
            description: "get",
            inputSchema: {
              type: "object",
              required: ["conversation_id"],
              properties: { conversation_id: { type: "string" } },
            },
          },
          {
            name: "sk.conversation.list",
            description: "list",
            inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
          },
        ],
      }));

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        try {
          if (name === "sk.ping") {
            const [h, ready] = await Promise.all([client.health(), client.ready()]);
            return {
              content: [
                {
                  type: "text",
                  text: `engine=${ctx.baseUrl} live=${h.status} ready=${ready.status}`,
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
            });
            return { content: [{ type: "text", text: JSON.stringify(created) }] };
          }
          if (name === "sk.conversation.append") {
            const out = await client.appendConversationMessage(String(args.conversation_id), {
              message: String(args.message),
            });
            return { content: [{ type: "text", text: JSON.stringify(out) }] };
          }
          if (name === "sk.conversation.get") {
            const detail = await client.getConversation(String(args.conversation_id));
            return { content: [{ type: "text", text: JSON.stringify(detail) }] };
          }
          if (name === "sk.conversation.list") {
            const res = await client.listConversations({ owner: "me", limit: 5 });
            return { content: [{ type: "text", text: JSON.stringify(res) }] };
          }
          return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
        } catch (err) {
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      });

      await server.connect(new NoopTransport() as never);

      const handlers = (
        server as unknown as {
          _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
        }
      )._requestHandlers;
      const listToolsHandler = handlers.get("tools/list");
      const callToolHandler = handlers.get("tools/call");
      if (!listToolsHandler || !callToolHandler) {
        throw new Error("MCP handlers not registered");
      }
      return {
        server,
        listTools: async () => listToolsHandler({ method: "tools/list", params: {} }, {}),
        callTool: async (name, args) =>
          callToolHandler({ method: "tools/call", params: { name, arguments: args } }, {}),
      };
    }

    interface ToolResponse {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-13-mcp-stdio");
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: ListTools returns all 5 sk.* tools", async () => {
      const { listTools } = await buildServer();
      const out = (await listTools()) as { tools: Array<{ name: string; inputSchema: unknown }> };
      const names = out.tools.map((t) => t.name);
      expect(names).toContain("sk.ping");
      expect(names).toContain("sk.conversation.create");
      expect(names).toContain("sk.conversation.append");
      expect(names).toContain("sk.conversation.get");
      expect(names).toContain("sk.conversation.list");
      for (const t of out.tools) expect(t.inputSchema).toBeDefined();
    });

    test("AC2: sk.ping returns the engine URL + health status", async () => {
      const { callTool } = await buildServer();
      const out = (await callTool("sk.ping", {})) as ToolResponse;
      expect(out.isError).toBeFalsy();
      expect(out.content[0]?.text).toContain("engine=");
      expect(out.content[0]?.text).toContain(ctx.baseUrl);
    });

    test("AC3: sk.conversation.create creates a conversation on the engine side", async () => {
      const { callTool } = await buildServer();
      const out = (await callTool("sk.conversation.create", {
        initial_message: "list my workflows",
      })) as ToolResponse;
      expect(out.isError).toBeFalsy();
      const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
        conversation?: { id?: string };
      };
      expect(parsed.conversation?.id).toBeDefined();
    });

    test("AC4: sk.conversation.list returns conversations owned by me", async () => {
      const { callTool } = await buildServer();
      await callTool("sk.conversation.create", { initial_message: "first" });
      await callTool("sk.conversation.create", { initial_message: "second" });
      const out = (await callTool("sk.conversation.list", { limit: 5 })) as ToolResponse;
      expect(out.isError).toBeFalsy();
      const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
        items?: Array<{ owner_id?: string | null }>;
      };
      expect(parsed.items).toBeDefined();
      expect((parsed.items ?? []).length).toBeGreaterThanOrEqual(2);
      for (const item of parsed.items ?? []) {
        expect(item.owner_id).toBe(ctx.userId);
      }
    });
  });

  describe("slash commands", () => {
    let ctx: JourneyCtx;

    let client: EngineClient;

    let profile: ResolvedProfile;

    let session: SkSessionState;

    function setConversationId(id: string | null): void {
      session = initialSessionState(id);
    }

    const ALLOWED = [
      "conversation:read",
      "conversation:write",
      "conversation:approve",
      "conversation:cancel",
      "conversation:list",
      "memory:write",
      "mcp:read",
      "skill:read",
      "audit:read",
      "identity:read",
    ];

    function slashCtx() {
      return {
        client,
        profile,
        session,
        setConversationId,
        allowedPermissions: ALLOWED,
      };
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-14-slash");
      profile = {
        name: "journey",
        engine_url: ctx.baseUrl,
        api_key: ctx.apiKey,
        active_tenant_id: ctx.tenantId,
        persona_hint: "admin",
      };
      client = new EngineClient({
        engine_url: profile.engine_url,
        api_key: profile.api_key,
        tenant: profile.active_tenant_id,
        user_agent: "sk-cli/0.0.1 (test)",
      });

      await ctx.db.insert(skills).values({
        tenant_id: ctx.tenantId,
        scope: "global",
        title: "Prefer list-users response shapes",
        body: "Keep list responses under 100 rows per page.",
        lifecycle: "active",
        version: 1,
      });

      session = initialSessionState(null);
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: /status reports profile + persona + session (multi-line when no openPane host)", async () => {
      const line = await handleSlash("status", [], slashCtx());
      expect(line).not.toBeNull();
      expect(line).toMatch(/profile\s+journey/);
      expect(line).toMatch(/persona\s+admin/);
      expect(line).toMatch(/engine\s+http/);
      expect(line).toMatch(/tenant/);
    });

    test("AC1b: /status in an Ink host opens a StatusPane via openPane", async () => {
      const opened: Array<
        Parameters<NonNullable<Parameters<typeof handleSlash>[2]["openPane"]>>[0]
      > = [];
      const line = await handleSlash("status", [], {
        ...slashCtx(),
        openPane: (spec) => opened.push(spec),
      });
      expect(line).toBeNull();
      expect(opened.length).toBe(1);
      const spec = opened[0];
      if (spec?.kind !== "status") throw new Error("expected status pane");
      const labels = spec.rows.map(([label]) => label);
      expect(labels).toContain("profile");
      expect(labels).toContain("persona");
      expect(labels).toContain("engine");
      expect(labels).toContain("tenant");
    });

    test("AC2: /clear resets the session id", async () => {
      setConversationId("fake-id");
      const line = await handleSlash("clear", [], slashCtx());
      expect(line).toBe("session cleared");
      expect(session.conversationId).toBeNull();
    });

    test("AC3: /compact on an active session calls the engine and reports the count", async () => {
      const outcome = await conversationsSvc.createConversation(
        {
          tenant_id: ctx.tenantId,
          actor_id: ctx.userId,
          initial_message: "list users",
        },
        ctx.db,
      );
      setConversationId(outcome.conversation.id);
      const line = await handleSlash("compact", [], slashCtx());
      expect(line).toMatch(/collapsed \d+ message/);
    });

    test("AC4: /model <id> patches the conversation and reports the switch", async () => {
      const outcome = await conversationsSvc.createConversation(
        { tenant_id: ctx.tenantId, actor_id: ctx.userId },
        ctx.db,
      );
      setConversationId(outcome.conversation.id);
      const line = await handleSlash("model", ["anthropic:claude-opus-4-6"], slashCtx());
      expect(line).toBe("model switched to anthropic:claude-opus-4-6");
    });

    test("AC5: /resume without an active session attaches to the most recent", async () => {
      setConversationId(null);
      const line = await handleSlash("resume", [], slashCtx());
      expect(typeof line).toBe("string");
      expect(session.conversationId).not.toBeNull();
    });

    test("AC6: /skills lists seeded skills", async () => {
      const line = await handleSlash("skills", [], slashCtx());
      expect(line).toContain("Prefer list-users response shapes");
    });

    test("AC7: /mcp renders prompts / resources / callable entries sections", async () => {
      const line = await handleSlash("mcp", [], slashCtx());
      expect(line).toContain("prompts (");
      expect(line).toContain("resources (");
      expect(line).toContain("callable entries (");
      expect(line).toContain("/mcp__skill_");
    });

    test("AC8: /permissions lists the granted permissions", async () => {
      const line = await handleSlash("permissions", [], slashCtx());
      expect(line).toContain("permissions");
      for (const p of ALLOWED) expect(line).toContain(p);
    });

    test("AC9: /audit tails the audit log for an admin", async () => {
      const line = await handleSlash("audit", [], slashCtx());
      expect(line).not.toBe("no audit rows visible to this principal");
      expect(typeof line).toBe("string");
      expect((line as string).split("\n").length).toBeGreaterThan(0);
    });
  });
});
