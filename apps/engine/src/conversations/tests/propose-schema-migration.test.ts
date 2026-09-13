// propose_schema_migration tool — surfaces the schema-evolution
// machinery to operators via the conversation-tool channel. Verifies
// the tool returns a structured plan for an evolved endpoint, the
// shape-stable case, the no-history case, and the sample-migration
// preview.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { connectors } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { recordSuccessShape } from "../../schema-versions/service.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { ToolContext } from "../tools/index.ts";
import { proposeSchemaMigrationTool } from "../tools/propose-schema-migration.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x9203_5c41a);

let ctx: ConversationTestCtx;
let connId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("propose-schema-migration");
  // Seed a separate connector for these tests so we don't collide
  // with whatever the shared scaffold pre-seeds.
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "schema-mig",
      display_name: "Schema Migration",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  connId = c!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("propose_schema_migration tool", () => {
  test("returns no_history when the endpoint has no recorded shapes", async () => {
    const result = await proposeSchemaMigrationTool.execute(makeCtx(), {
      connector_id: connId,
      endpoint_key: "GET /never-seen",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { status: string; plan: unknown };
    expect(data.status).toBe("no_history");
    expect(data.plan).toBeNull();
  });

  test("surfaces a rename plan + migrated sample", async () => {
    const ek = "GET /v1/migration-rename";
    await recordSuccessShape(
      {
        tenant_id: ctx.tenant_id,
        connector_id: connId,
        endpoint_key: ek,
        value: { user_id: 7, score: 0.5 },
      },
      ctx.testDb.db,
    );
    await recordSuccessShape(
      {
        tenant_id: ctx.tenant_id,
        connector_id: connId,
        endpoint_key: ek,
        value: { id: 7, score: 0.5 },
      },
      ctx.testDb.db,
    );
    const result = await proposeSchemaMigrationTool.execute(makeCtx(), {
      connector_id: connId,
      endpoint_key: ek,
      sample: { user_id: 99, score: 0.42 },
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      status: string;
      plan: { steps: Array<{ kind: string; from?: string; path: string }> };
      migrated_sample: unknown;
    };
    expect(data.status).toBe("migration_proposed");
    const rename = data.plan.steps.find((s) => s.kind === "rename");
    expect(rename?.from).toBe("user_id");
    expect(rename?.path).toBe("id");
    expect(data.migrated_sample).toEqual({ id: 99, score: 0.42 });
  });

  test("shape-stable history returns status: shape_stable, empty steps", async () => {
    const ek = "GET /v1/migration-stable";
    await recordSuccessShape(
      {
        tenant_id: ctx.tenant_id,
        connector_id: connId,
        endpoint_key: ek,
        value: { id: 1 },
      },
      ctx.testDb.db,
    );
    await recordSuccessShape(
      {
        tenant_id: ctx.tenant_id,
        connector_id: connId,
        endpoint_key: ek,
        value: { id: 2 },
      },
      ctx.testDb.db,
    );
    const result = await proposeSchemaMigrationTool.execute(makeCtx(), {
      connector_id: connId,
      endpoint_key: ek,
    });
    const data = result.data as { status: string; plan: { steps: unknown[] } };
    expect(data.status).toBe("shape_stable");
    expect(data.plan.steps).toEqual([]);
  });

  test("history_count + first/latest seen_at surface chronological context", async () => {
    const ek = "GET /v1/migration-history";
    // The two recordings must differ in SHAPE (number -> string), not just
    // value: identical shapes dedup into one row now (a workflow on a
    // minute schedule must not grow schema_versions by one row per run),
    // so history_count counts shape CHANGES.
    await recordSuccessShape(
      {
        tenant_id: ctx.tenant_id,
        connector_id: connId,
        endpoint_key: ek,
        value: { v: 1 },
      },
      ctx.testDb.db,
    );
    await recordSuccessShape(
      {
        tenant_id: ctx.tenant_id,
        connector_id: connId,
        endpoint_key: ek,
        value: { v: "two" },
      },
      ctx.testDb.db,
    );
    const result = await proposeSchemaMigrationTool.execute(makeCtx(), {
      connector_id: connId,
      endpoint_key: ek,
    });
    const data = result.data as {
      history_count: number;
      first_seen_at: Date;
      latest_seen_at: Date;
    };
    expect(data.history_count).toBe(2);
    expect(data.first_seen_at).toBeInstanceOf(Date);
    expect(data.latest_seen_at).toBeInstanceOf(Date);
  });
});
