import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors as connectorsTable, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { authenticateOAuthTool } from "../tools/authenticate-oauth.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("authenticate_oauth_tool");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-aoauth", display_name: "T-AOAUTH" })
    .returning();
  tenant_id = t!.id;
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = conv!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function buildToolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const base: ToolContext = {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => ({}) as DraftDocument,
    setDraft: async () => {},
    abortSignal: new AbortController().signal,
  };
  return { ...base, ...overrides };
}

describe("authenticateOAuthTool", () => {
  test("returns no_saved_connector when connector_id is missing and ctx has none", async () => {
    const result = await authenticateOAuthTool.execute(buildToolCtx(), {});
    expect(result.ok).toBe(false);
    const data = result.data as { error: string };
    expect(data.error).toBe("no_saved_connector");
  });

  test("returns connector_missing for an unknown connector id", async () => {
    const result = await authenticateOAuthTool.execute(buildToolCtx(), {
      connector_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: string }).error).toBe("connector_missing");
  });

  test("returns oauth_not_configured for a non-OAuth connector", async () => {
    const [conn] = await ctx.db
      .insert(connectorsTable)
      .values({
        tenant_id,
        slug: "non-oauth",
        display_name: "Non-OAuth",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        config: { base_url: "https://example.test" },
      })
      .returning({ id: connectorsTable.id });
    const result = await authenticateOAuthTool.execute(buildToolCtx(), {
      connector_id: conn!.id,
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: string }).error).toBe("oauth_not_configured");
  });
});
