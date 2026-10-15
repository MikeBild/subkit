import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { cannotHelpTool } from "../cannot-help.ts";
import type { ToolContext } from "../index.ts";

let database: TestDb;
let ctx: ToolContext;

beforeAll(async () => {
  database = await createTestDb("cannot_help");
  const [tenant] = await database.db
    .insert(tenants)
    .values({ slug: "cannot-help", display_name: "Cannot help" })
    .returning();
  const [conversation] = await database.db
    .insert(conversations)
    .values({ tenant_id: tenant!.id, status: "active", draft: {} })
    .returning();
  ctx = {
    tenant_id: tenant!.id,
    conversation_id: conversation!.id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    db: database.db,
    engineClient: new EngineClient({ tenant_id: tenant!.id, actor_id: null, db: database.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
});

afterAll(async () => {
  await database?.cleanup();
});

describe("cannot_help", () => {
  it("registers as a tenant_read tool with a stable name", () => {
    expect(cannotHelpTool.name).toBe("cannot_help");
    expect(cannotHelpTool.category).toBe("tenant_read");
  });

  it("returns ok=true with abstained=true and the verbatim reason", async () => {
    const result = await cannotHelpTool.execute(ctx, {
      reason: "I do not have a verified Codex MCP config in this engine yet.",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      abstained: true,
      reason: "I do not have a verified Codex MCP config in this engine yet.",
    });
  });

  it("round-trips the optional missing_capability and suggest_alternative", async () => {
    const result = await cannotHelpTool.execute(ctx, {
      reason: "no recipe",
      missing_capability: "vendor_recipe.codex",
      suggest_alternative: "Check the official Codex MCP docs.",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      abstained: true,
      reason: "no recipe",
      missing_capability: "vendor_recipe.codex",
      suggest_alternative: "Check the official Codex MCP docs.",
    });
  });

  it("rejects an empty reason", () => {
    expect(() => cannotHelpTool.execute(ctx, { reason: "" })).toThrow();
  });

  it("rejects a missing reason", () => {
    expect(() => cannotHelpTool.execute(ctx, {})).toThrow();
  });

  it("rejects unknown fields outright (sealSchema applied at registration)", async () => {
    const sealedFromRegistry = (await import("../index.ts")).getTool("cannot_help")!.inputSchema;
    expect(sealedFromRegistry.safeParse({ reason: "ok", not_a_real_field: "x" }).success).toBe(
      false,
    );
  });
});
