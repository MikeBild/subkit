import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { auditLog, conversations } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { freshSignals } from "../../tests/turn-signals.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { __setExternalMcpToolsBuilderForTests } from "../sdk-wrap/external-mcp-tools.ts";
import { wrapTools } from "../sdk-wrap.ts";

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;
let conversation_id: string;

beforeAll(async () => {
  __setExternalMcpToolsBuilderForTests(async () => {
    throw new Error(
      "enumeration blew up: GET https://mcp.example.test/rpc?session=topsecret123 returned 500",
    );
  });

  ctx = await createTestDb("external-mcp-palette-failure");
  tenant_id = (await seedTenant(ctx.db, { slug: "t-palette-fail", display_name: "Palette Fail" }))
    .id;
  actor_id = createDeterministicUuidFactory(321)();
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;
}, 30_000);

afterAll(async () => {
  __setExternalMcpToolsBuilderForTests(null);
  await ctx.cleanup();
}, 30_000);

describe("external MCP palette-assembly failure audit", () => {
  test("degrades to in-repo tools AND writes mcp_external_tool.palette_assembly_failed", async () => {
    const events: TurnEvent[] = [];
    const db = ctx.db as unknown as Db;
    const engineClient = new EngineClient({
      tenant_id,
      actor_id,
      actor_type: "user",
      db,
    });
    const toolCtx: ToolContext = {
      db,
      tenant_id,
      conversation_id,
      actor_id,
      connector_id: null,
      workflow_id: null,
      engineClient,
      getDraft: () => ({ workflow: { name: "", steps: [] } }),
      setDraft: async () => {},
    };
    const principal: ResolvedPrincipal = {
      provider: "test",
      kind: "user",
      id: actor_id,
      tenant_id,
      roles: ["admin"],
    };

    const wrapped = await wrapTools(toolCtx, freshSignals(), events, db, [], {}, null, principal);

    expect(Object.keys(wrapped).length).toBeGreaterThan(0);

    const rows = await ctx.db
      .select({
        action: auditLog.action,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.resource_id, tenant_id));
    const failure = rows.filter((r) => r.action === "mcp_external_tool.palette_assembly_failed");
    expect(failure.length).toBe(1);
    expect(failure[0]!.result).toBe("error");
    expect(failure[0]!.reason).toBe("pool_fault");
    const meta = failure[0]!.metadata as Record<string, unknown>;
    expect(meta.detail).toBe("enumeration blew up: GET https://mcp.example.test returned 500");
    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain("topsecret123");
    expect(metaStr).not.toContain("/rpc");
  });
});
