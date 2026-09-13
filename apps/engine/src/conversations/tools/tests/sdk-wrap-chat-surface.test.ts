// The chat surface's palette switch in `wrapTools`:
//
//   - `ctx.surface === "chat"` → the fixed read-only allow-list
//     (CHAT_READONLY_TOOLS), independent of loadedSkills; external MCP
//     tools skipped.
//   - any other / absent surface → today's authoring palette,
//     unchanged (the web/CLI/MCP regression guard).
//
// The default-path guard matters most: the read-only branch is
// additive-conditional, and this test fails loudly if a refactor ever
// makes the restriction leak into the default palette (or vice versa).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
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
      // Deliberately load BOTH authoring skills: on the chat surface
      // they must unlock nothing.
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

    // The knowledge-read path must actually REACH chat, not just avoid
    // leaking. The allow-list is fail-closed, so a read tool that nobody
    // adds to it is silently unavailable on Slack/Teams/Google Chat while
    // the docs advertise it — `read_knowledge` shipped that way once.
    // Presence assertions, not just absence ones, are what catch that.
    for (const expected of [
      "search_knowledge",
      "read_knowledge",
      "list_knowledge_sources",
      "get_knowledge_source",
    ]) {
      expect(names.has(expected), `${expected} must be reachable on chat`).toBe(true);
    }
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
    // The authoring surface must keep its full contract: builder,
    // editor, persistence, connector tools, and the tenant_read
    // catch-all (call_connector).
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
