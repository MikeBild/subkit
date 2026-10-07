import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  executionFixtures,
  executionSteps,
  executions,
  tenants,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../../../storage/object-store.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/index.ts";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { inspectExecutionStepTool } from "../inspect-execution-step.ts";

const nextStorageUri = createDeterministicUuidFactory(0xfaceb00c);

let ctx: TestDb;
let tenant_id: string;
let foreign_tenant_id: string;
let objectStore: MemoryObjectStore;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  objectStore = new MemoryObjectStore();
  setObjectStoreForTesting(objectStore);
  ctx = await createTestDb("inspect_exec_step");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-inspect-exec", display_name: "T1" })
    .returning();
  tenant_id = t!.id;
  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-foreign-exec", display_name: "T2" })
    .returning();
  foreign_tenant_id = t2!.id;
}, 30_000);

afterAll(async () => {
  setObjectStoreForTesting(null);
  await ctx.cleanup();
}, 30_000);

function makeCtx(): ToolContext & { draft: DraftDocument } {
  let draft = createEmptyDraftDocument();
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: shape-only test
    actor_id: null,
    principal: adminPrincipal(tenant_id),
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    get draft() {
      return draft;
    },
  } as ToolContext & { draft: DraftDocument };
}

async function seedExecutionWithStep(opts: {
  tenant: string;
  step_key: string;
}): Promise<{ execution_id: string; step_id: string }> {
  const [exec] = await ctx.db
    .insert(executions)
    .values({
      tenant_id: opts.tenant,
      status: "succeeded",
      source_kind: "draft",
      request_source: "test",
      execution_mode: "dev",
    })
    .returning();
  if (!exec) throw new Error("seed execution failed");
  const [step] = await ctx.db
    .insert(executionSteps)
    .values({
      tenant_id: opts.tenant,
      execution_id: exec.id,
      step_key: opts.step_key,
      kind: "request",
      status: "succeeded",
      result_storage_uri: `fixture://${nextStorageUri()}`,
      output_preview: { _truncated: "offloaded" },
    })
    .returning();
  if (!step) throw new Error("seed step failed");
  return { execution_id: exec.id, step_id: step.id };
}

describe("inspect_execution_step · canonical offload resolution", () => {
  test("returns an S3-backed body when include_full_payload=true", async () => {
    const { execution_id, step_id } = await seedExecutionWithStep({
      tenant: tenant_id,
      step_key: "fetch_offload_payload",
    });
    const key = `offload/${tenant_id}/${execution_id}/inspect.json`;
    await objectStore.put(
      key,
      Buffer.from(JSON.stringify({ storage: { value: "<p>real-body</p>" } })),
    );
    await ctx.db
      .update(executionSteps)
      .set({ result_storage_uri: `s3://test/${key}` })
      .where(eq(executionSteps.id, step_id));
    const toolCtx = makeCtx();
    const result = await inspectExecutionStepTool.execute(toolCtx, {
      execution_id,
      step_key: "fetch_offload_payload",
      include_full_payload: true,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      payload_source: string;
      full_payload?: { storage?: { value?: string } };
      offloaded: boolean;
    };
    expect(data.payload_source).toBe("offload");
    expect(data.offloaded).toBe(true);
    expect(data.full_payload?.storage?.value).toBe("<p>real-body</p>");
  });

  test("rejects a self-healing fixture URI instead of exposing its body", async () => {
    const { execution_id, step_id } = await seedExecutionWithStep({
      tenant: tenant_id,
      step_key: "fetch_self_healing_only",
    });
    const [fixture] = await ctx.db
      .insert(executionFixtures)
      .values({
        tenant_id,
        kind: "fixture",
        execution_id,
        step_id,
        body: { storage: { value: "self-healing-body-should-not-leak" } },
        byte_size: 512,
      })
      .returning({ id: executionFixtures.id });
    await ctx.db
      .update(executionSteps)
      .set({ result_storage_uri: `fixture://${fixture!.id}` })
      .where(eq(executionSteps.id, step_id));
    const toolCtx = makeCtx();
    const result = await inspectExecutionStepTool.execute(toolCtx, {
      execution_id,
      step_key: "fetch_self_healing_only",
      include_full_payload: true,
    });
    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code: string;
      message: string;
    };
    expect(data.error_code).toBe("offload_resolution_failed");
    expect(data.message).not.toContain("self-healing-body-should-not-leak");
  });

  test("does NOT leak a foreign-tenant fixture row that shares step_id", async () => {
    const { execution_id: foreignExec, step_id: foreignStep } = await seedExecutionWithStep({
      tenant: foreign_tenant_id,
      step_key: "foreign_step",
    });
    await ctx.db.insert(executionFixtures).values({
      tenant_id: foreign_tenant_id,
      kind: "offload",
      execution_id: foreignExec,
      step_id: foreignStep,
      body: { storage: { value: "foreign-tenant-secret" } },
      byte_size: 256,
    });
    const toolCtx = makeCtx();
    const result = await inspectExecutionStepTool.execute(toolCtx, {
      execution_id: foreignExec,
      step_key: "foreign_step",
      include_full_payload: true,
    });
    expect(result.ok).toBe(false);
    const data = result.data as { error_code: string };
    expect(data.error_code).toBe("execution_not_found");
  });
});
