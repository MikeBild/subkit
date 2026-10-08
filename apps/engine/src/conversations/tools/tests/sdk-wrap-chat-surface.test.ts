import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { auditLog, conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import type { TurnEvent } from "../../types.ts";
import { CHAT_READONLY_TOOLS } from "../authoring-palette.ts";
import type { ToolContext } from "../index.ts";
import { type TurnSignals, wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("sdk-wrap-chat-surface");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

function freshSignals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
}

function makeCtx(surface?: "chat" | "web"): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: ctx.tenant_id,
    actor_id: null,
    actor_type: "system",
    db: ctx.testDb.db as unknown as Db,
  });
  return {
    db: ctx.testDb.db as unknown as Db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    ...(surface ? { surface } : {}),
  };
}

describe("wrapTools chat-surface palette switch", () => {
  it("chat surface exposes exactly the read-only allow-list — even with authoring skills loaded", async () => {
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      makeCtx("chat"),
      freshSignals(),
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring", "connector-creation-guidance"],
      {},
    );
    const names = new Set(Object.keys(wrapped));
    for (const name of names) {
      expect(CHAT_READONLY_TOOLS.has(name), `${name} leaked into the chat palette`).toBe(true);
    }
    for (const forbidden of [
      "call_connector",
      "author_workflow",
      "edit_workflow_patch",
      "save_workflow_draft",
      "update_workflow",
      "delete_workflow",
      "dry_run_workflow",
    ]) {
      expect(names.has(forbidden), `${forbidden} must be absent on chat`).toBe(false);
    }
    expect(names.has("run_workflow")).toBe(true);
    expect(names.has("find_workflow")).toBe(true);

    for (const expected of [
      "search_knowledge",
      "read_knowledge",
      "list_knowledge_sources",
      "get_knowledge_source",
    ]) {
      expect(names.has(expected), `${expected} must be reachable on chat`).toBe(true);
    }
  });

  it("a chat-provider principal without surface=chat gets the read-only palette and one audit row", async () => {
    const principal: ResolvedPrincipal = {
      provider: "chat",
      kind: "user",
      id: "u-chat-provider",
      tenant_id: ctx.tenant_id,
      roles: ["admin"],
    };
    const enforcedRows = () =>
      ctx.testDb.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, ctx.tenant_id),
            eq(auditLog.action, "conversation.palette_surface_enforced"),
          ),
        );

    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      makeCtx(),
      freshSignals(),
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring", "connector-creation-guidance"],
      {},
      null,
      principal,
    );
    const names = Object.keys(wrapped);
    for (const name of names) {
      expect(
        CHAT_READONLY_TOOLS.has(name) || name.startsWith("wf_"),
        `${name} leaked past the chat palette`,
      ).toBe(true);
    }
    for (const forbidden of ["call_connector", "author_workflow", "delete_workflow"]) {
      expect(names.includes(forbidden), `${forbidden} must be absent`).toBe(false);
    }

    const rows = await enforcedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resource_type).toBe("conversation");
    expect(rows[0]!.resource_id).toBe(conversation_id);
    expect(rows[0]!.result).toBe("success");
    expect(rows[0]!.reason).toBe("chat_provider_without_chat_surface");
    expect(rows[0]!.metadata).toEqual({
      conversation_id,
      request_source: "chat",
      palette: "chat_read_only",
    });

    await wrapTools(
      makeCtx("chat"),
      freshSignals(),
      [],
      ctx.testDb.db as unknown as Db,
      [],
      {},
      null,
      principal,
    );
    expect(await enforcedRows()).toHaveLength(1);
  });

  it("absent surface keeps today's authoring palette (web/CLI/MCP regression guard)", async () => {
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      makeCtx(),
      freshSignals(),
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring", "connector-creation-guidance"],
      {},
    );
    const names = new Set(Object.keys(wrapped));
    for (const expected of [
      "author_workflow",
      "edit_workflow_patch",
      "save_workflow_draft",
      "call_connector",
      "update_workflow",
      "delete_workflow",
      "dry_run_workflow",
      "list_workflows",
    ]) {
      expect(names.has(expected), `${expected} missing from the default palette`).toBe(true);
    }
  });
});
