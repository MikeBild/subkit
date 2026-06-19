// Regression test for the W3 / Root-cause-2 fix at
// `apps/engine/src/conversations/tools/inspect-execution-step.ts:131-145`.
// The previous query joined `executionFixtures.id == step.id` (the
// fixture row's own PK vs. the step row's PK — different identity
// domains, so the join silently never matched). The fix correctly
// joins on `step_id` AND filters `kind = "offload"` so self-healing
// fixtures (`kind = "fixture"`) don't masquerade as the offloaded
// body, and so a foreign-tenant row never leaks via `step_id`
// collision.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  executionFixtures,
  executionSteps,
  executions,
  tenants,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { inspectExecutionStepTool } from "../inspect-execution-step.ts";

const nextStorageUri = createDeterministicUuidFactory(0xfaceb00c);

let ctx: TestDb;
let tenant_id: string;
let foreign_tenant_id: string;

beforeAll(async () => {
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
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(): ToolContext & { draft: DraftDocument } {
  let draft = createEmptyDraftDocument();
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: shape-only test
    actor_id: null,
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
      // Mark the step as offloaded so the include_full_payload branch
      // fires. URI shape only — the tool queries fixtures by step_id,
      // not by URI, so we use a deterministic factory.
      result_storage_uri: `fixture://${nextStorageUri()}`,
      output_preview: { _truncated: "offloaded" },
    })
    .returning();
  if (!step) throw new Error("seed step failed");
  return { execution_id: exec.id, step_id: step.id };
}

describe("inspect_execution_step · offload-fixture FK fix (W3)", () => {
  test("returns the kind='offload' body when include_full_payload=true", async () => {
    const { execution_id, step_id } = await seedExecutionWithStep({
      tenant: tenant_id,
      step_key: "fetch_offload_payload",
    });
    // Seed an `offload` fixture row keyed by step_id with the real body.
    await ctx.db.insert(executionFixtures).values({
      tenant_id,
      kind: "offload",
      execution_id,
      step_id,
      body: { storage: { value: "<p>real-body</p>" } },
      byte_size: 1024,
    });
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

  test("does NOT return a kind='fixture' row even when it shares step_id", async () => {
    const { execution_id, step_id } = await seedExecutionWithStep({
      tenant: tenant_id,
      step_key: "fetch_self_healing_only",
    });
    // Only a self-healing fixture exists for this step — no offload row.
    await ctx.db.insert(executionFixtures).values({
      tenant_id,
      kind: "fixture",
      execution_id,
      step_id,
      body: { storage: { value: "self-healing-body-should-not-leak" } },
      byte_size: 512,
    });
    const toolCtx = makeCtx();
    const result = await inspectExecutionStepTool.execute(toolCtx, {
      execution_id,
      step_key: "fetch_self_healing_only",
      include_full_payload: true,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      payload_source: string;
      full_payload?: unknown;
    };
    // The offload-filter must exclude the kind='fixture' row even though
    // it shares step_id. The body must not leak.
    expect(data.full_payload).toBeUndefined();
    // payload_source stays at the inferred default ("preview" when an
    // output_preview is present, "none" otherwise) — never "offload".
    expect(data.payload_source).not.toBe("offload");
  });

  test("does NOT leak a foreign-tenant fixture row that shares step_id", async () => {
    // Seed the offload row under the foreign tenant — same step_id
    // shape, different tenant_id. The tenant predicate must filter it.
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
    const toolCtx = makeCtx(); // Uses `tenant_id`, NOT `foreign_tenant_id`.
    // Caller asks for the foreign execution — must get execution_not_found.
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
