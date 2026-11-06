import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { findConnectorTool } from "../tools/find-connector.ts";
import { findWorkflowTool } from "../tools/find-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import { freshSignals } from "./turn-signals.ts";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SQL_MARKERS = ["Failed query", "select ", "tenant_id", "params:"];

let ctx: LlmTestCtx;
let conversationId: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("tool-lookup-id");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation seed failed");
  conversationId = row.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function toolCtx(): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

function expectNoSql(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const marker of SQL_MARKERS) expect(serialized).not.toContain(marker);
}

describe("find_connector id normalization", () => {
  test("the PROD input with id '*' ranks by query instead of leaking a database error", async () => {
    const result = await findConnectorTool.execute(toolCtx(), {
      id: "*",
      limit: 15,
      query: "GitHub GraphQL production api.github.com/graphql",
      category: "",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    expectNoSql(result);
  });

  test("an empty category does not filter every connector away", async () => {
    const result = await findConnectorTool.execute(toolCtx(), {
      id: NIL_UUID,
      query: "API",
      category: "",
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { matches: Array<{ id: string }> } }).data;
    expect(data.matches.map((m) => m.id)).toContain(ctx.connector_id);
  });

  test("a malformed id is refused with invalid_id before any lookup", async () => {
    const result = await findConnectorTool.execute(toolCtx(), { id: "not-a-uuid" });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("invalid_id");
    expectNoSql(result);
  });
});

describe("find_workflow id normalization", () => {
  for (const id of ["*", NIL_UUID]) {
    test(`id ${JSON.stringify(id)} is treated as omitted`, async () => {
      const result = await findWorkflowTool.execute(toolCtx(), { id, query: "briefing" });
      expect(result.ok).toBe(true);
      expectNoSql(result);
    });
  }

  test("a malformed id is refused with invalid_id", async () => {
    const result = await findWorkflowTool.execute(toolCtx(), { id: "briefing" });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("invalid_id");
  });
});

describe("tool database errors stay out of the model's context", () => {
  test("a thrown query error is persisted and emitted as tool_execution_failed without SQL", async () => {
    const events: TurnEvent[] = [];
    const context = toolCtx();
    const failing = spyOn(context.engineClient.connectors, "get").mockImplementation(async () => {
      throw new Error(
        'Failed query: select "id", "tenant_id", "slug" from "subkit"."connectors" where "connectors"."id" = $1\nparams: *',
      );
    });
    try {
      const wrapped = await wrapTools(context, freshSignals(), events, ctx.testDb.db, [], {});
      const tool = wrapped.find_connector;
      if (!tool?.execute) throw new Error("find_connector not wrapped");
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = (await (tool.execute as any)(
        { id: ctx.connector_id, limit: 15 },
        { toolCallId: "db-error-call", messages: [] },
      )) as { ok: boolean; data: unknown };
      expect(result.ok).toBe(false);
      expect(result.data).toMatchObject({ ok: false, error_code: "tool_execution_failed" });
      expectNoSql(result);
      const emitted = events.find((e) => e.type === "tool_result" && e.tool === "find_connector");
      expect(emitted).toBeDefined();
      expectNoSql(emitted);
      const rows = await ctx.testDb.db
        .select({ output: conversationToolCalls.output })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, ctx.tenant_id),
            eq(conversationToolCalls.conversation_id, conversationId),
            eq(conversationToolCalls.tool, "find_connector"),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expectNoSql(row.output);
    } finally {
      failing.mockRestore();
    }
  });
});
