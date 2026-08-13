// Integration test for the default-deny execution-tool gate against a REAL
// palette. Uses testcontainers postgres (createTestDb): seeds a saved workflow
// so wrapTools builds the genuine `wf_<slug>` synthetic peer, then drives the
// SAME gate helpers the loop calls (collectSyntheticWorkflowSlugs →
// resolveExecutionToolGate → applyExecutionToolGate).
//
// This is the regression that the build-new hijack lacked: it proves that for a
// fresh authoring conversation (no bound workflow, no named slug) BOTH
// run_workflow AND the lookalike `wf_notion-essay-to-markdown` peer are removed
// — so the model cannot satisfy a "build a new Notion reader" request by running
// the existing essay workflow and stalling on its input form. It also proves the
// legitimate paths stay open: naming the slug, or a bound saved workflow, keeps
// execution exposed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { tenants } from "../../../db/schema/identity.ts";
import { conversations, workflows, workflowVersions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
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

async function buildRealPalette(): Promise<Record<string, unknown>> {
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
    // The reported repro: unbound conversation, negated build request — no slug named.
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
    // Authoring tools remain reachable.
    expect(palette.list_workflows).toBeDefined();
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
    // The loop sets `{ exposeExecution: true, reason: "chat_surface" }` for
    // `p.surface === "chat"` INSTEAD of computing the default-deny gate. Chat is
    // a fixed read-only palette that cannot author, so the build-new lookalike
    // hijack the gate guards against is impossible there — default-denying
    // instead dead-ends the intended run (e.g. after `ask_user_choice`
    // disambiguation with no commit_intent). Model the chat decision against the
    // REAL palette: both run_workflow and the wf_<slug> peer must survive even
    // though nothing is bound and no slug was named this turn.
    const palette = await buildRealPalette();
    const slugs = collectSyntheticWorkflowSlugs(Object.keys(palette));
    const message = "gib mir das wetter von übermorgen"; // paraphrase, no slug named
    expect(resolveNamedWorkflowSlug(message, slugs)).toBeNull();
    const decision = { exposeExecution: true as const, reason: "chat_surface" as const };
    const removed = applyExecutionToolGate(palette, decision, slugs);
    expect(removed).toBe(0);
    expect(palette.run_workflow).toBeDefined();
    expect(palette[`wf_${LOOKALIKE_SLUG}`]).toBeDefined();
  });
});
