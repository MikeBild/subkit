import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { tenants } from "../../../db/schema/identity.ts";
import {
  conversations,
  executions,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { detectUserIntent } from "../../intent-detector.ts";
import type { TurnEvent } from "../../types.ts";
import {
  applyExecutionToolGate,
  collectSyntheticWorkflowSlugs,
  resolveExecutionToolGate,
  resolveNamedWorkflowSlug,
} from "../authoring-palette.ts";
import type { ToolContext } from "../index.ts";
import { type TurnSignals, wrapTools } from "../sdk-wrap.ts";

const LOOKALIKE_SLUG = "notion-essay-to-markdown";

let tdb: TestDb;
let tenantId: string;
let conversationId: string;

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

async function seedTool(slug: string): Promise<void> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "active", is_tool: true })
    .returning();
  if (!wf) throw new Error("workflow seed failed");
  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: { name: slug, slug, steps: [{ id: "s1", kind: "request", url: "https://example.com" }] },
    })
    .returning();
  if (!v) throw new Error("version seed failed");
  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
}

async function buildRealPalette(recentUserMessage?: string): Promise<Record<string, unknown>> {
  const db = tdb.db as unknown as Db;
  const events: TurnEvent[] = [];
  const engineClient = new EngineClient({
    tenant_id: tenantId,
    actor_id: null,
    actor_type: "user",
    db,
  });
  const toolCtx: ToolContext = {
    db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    ...(recentUserMessage ? { recentUserMessage } : {}),
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } as never }),
    setDraft: async () => {},
  } as ToolContext;
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: "00000000-0000-0000-0000-0000000000fc",
    tenant_id: tenantId,
    roles: ["admin"],
  };
  return wrapTools(toolCtx, freshSignals(), events, db, [], {}, null, principal) as Promise<
    Record<string, unknown>
  >;
}

beforeAll(async () => {
  tdb = await createTestDb("execution-tool-gate");
  const [t] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-exec-gate", display_name: "Execution Gate Tenant" })
    .returning();
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const [conv] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("conversation seed failed");
  conversationId = conv.id;
  await seedTool(LOOKALIKE_SLUG);
}, 60_000);

afterAll(async () => {
  await tdb.cleanup();
}, 30_000);

describe("execution-tool gate against a real palette", () => {
  test("the seeded workflow surfaces run_workflow + its wf_<slug> peer", async () => {
    const palette = await buildRealPalette();
    expect(palette.run_workflow).toBeDefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeDefined();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    expect(slugs.has(LOOKALIKE_SLUG)).toBe(true);
  });

  test("fresh build-new turn removes BOTH run_workflow and the lookalike peer", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    const message =
      "Build a NEW workflow that reads any Notion page. Do NOT run any existing essay workflow.";
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: resolveNamedWorkflowSlug(message, slugs),
    });
    expect(gate.exposeExecution).toBe(false);
    expect(gate.reason).toBe("authoring_no_target");
    const removed = applyExecutionToolGate(palette, gate, slugs);
    expect(removed).toBe(2);
    expect(palette.run_workflow).toBeUndefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeUndefined();
    expect(palette.list_workflows).toBeDefined();
  });

  test("fresh build-new turn keeps single-step draft preview available", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    palette.dry_run_step = {};
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: null,
    });

    const removed = applyExecutionToolGate(palette, gate, slugs);

    expect(removed).toBe(2);
    expect(palette.dry_run_step).toBeDefined();
    expect(palette.run_workflow).toBeUndefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeUndefined();
  });

  test("explicit no-run request removes single-step draft preview", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    palette.dry_run_step = {};
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: null,
      suppressExecution: true,
    });

    applyExecutionToolGate(palette, gate, slugs);

    expect(palette.dry_run_step).toBeUndefined();
  });

  test("naming the saved-workflow slug keeps execution exposed (legitimate run)", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    const message = `run ${LOOKALIKE_SLUG} for page 386492c6`;
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: resolveNamedWorkflowSlug(message, slugs),
    });
    expect(gate.exposeExecution).toBe(true);
    expect(gate.reason).toBe("named_workflow_slug");
    const removed = applyExecutionToolGate(palette, gate, slugs);
    expect(removed).toBe(0);
    expect(palette.run_workflow).toBeDefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeDefined();
  });

  test("a bound saved workflow keeps execution exposed ('run it')", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: true,
      explicitlyNamedWorkflowSlug: null,
    });
    expect(gate.exposeExecution).toBe(true);
    const removed = applyExecutionToolGate(palette, gate, slugs);
    expect(removed).toBe(0);
    expect(palette.run_workflow).toBeDefined();
  });

  test("an explicit no-run decision removes execution even for a bound workflow", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    const decision = { exposeExecution: false as const, reason: "explicit_no_run" as const };
    const removed = applyExecutionToolGate(palette, decision, slugs);
    expect(removed).toBe(2);
    expect(palette.run_workflow).toBeUndefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeUndefined();
    expect(palette.list_workflows).toBeDefined();
  });

  test("chat surface exposes execution with no bound target and no named slug", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    const message = "gib mir das wetter von übermorgen";
    expect(resolveNamedWorkflowSlug(message, slugs)).toBeNull();
    const decision = { exposeExecution: true as const, reason: "chat_surface" as const };
    const removed = applyExecutionToolGate(palette, decision, slugs);
    expect(removed).toBe(0);
    expect(palette.run_workflow).toBeDefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeDefined();
  });

  test("explicit no-run wording hides execution on chat even when a workflow is named", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    const message =
      "Untersuche den gespeicherten fehlgeschlagenen Lauf. Ändere nichts und führe keinen Lauf aus.";
    const intent = detectUserIntent(message);
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: true,
      explicitlyNamedWorkflowSlug: resolveNamedWorkflowSlug(message, slugs),
      surface: "chat",
      suppressExecution: intent.suppressExecution === true,
    });
    const removed = applyExecutionToolGate(palette, gate, slugs);
    expect(gate).toEqual({ exposeExecution: false, reason: "explicit_no_run" });
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(palette.run_workflow).toBeUndefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeUndefined();
    expect(palette.dry_run_workflow).toBeUndefined();
    expect(palette.dry_run_step).toBeUndefined();
    expect(palette.list_executions).toBeDefined();
  });

  test("a no-live-effects preparation keeps the held-write preview and hides live runs", async () => {
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    palette.dry_run_workflow = {};
    const intent = detectUserIntent(
      "Bereite diesen Ablauf für den automatischen Betrieb vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen.",
    );
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: true,
      explicitlyNamedWorkflowSlug: null,
      surface: "chat",
      suppressExecution: intent.suppressExecution === true,
      suppressLiveExecution: intent.suppressLiveExecution === true,
    });
    applyExecutionToolGate(palette, gate, slugs);
    expect(gate).toEqual({ exposeExecution: false, reason: "explicit_no_live_effects" });
    expect(palette.run_workflow).toBeUndefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeUndefined();
    expect(palette.dry_run_workflow).toBeDefined();
  });

  test("a direct run_workflow tool call is denied before execution on an explicit no-run turn", async () => {
    const palette = await buildRealPalette("Ändere nichts und führe keinen Lauf aus.");
    const runTool = palette.run_workflow as {
      execute?: (
        args: Record<string, unknown>,
      ) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
    };
    expect(runTool.execute).toBeDefined();
    const before = await tdb.db.select().from(executions);
    const output = await runTool.execute?.({ workflow: LOOKALIKE_SLUG, execute_writes: false });
    const after = await tdb.db.select().from(executions);
    expect(output?.data.error_code).toBe("explicit_no_run");
    expect(after).toHaveLength(before.length);
  });

  test("a direct run_workflow call is denied on a no-live-effects turn", async () => {
    const palette = await buildRealPalette(
      "Bereite diesen Ablauf vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen.",
    );
    const runTool = palette.run_workflow as {
      execute?: (
        args: Record<string, unknown>,
      ) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
    };
    const before = await tdb.db.select().from(executions);
    const output = await runTool.execute?.({ workflow: LOOKALIKE_SLUG, execute_writes: false });
    const after = await tdb.db.select().from(executions);
    expect(output?.data.error_code).toBe("explicit_no_live_effects");
    expect(after).toHaveLength(before.length);
  });
});
