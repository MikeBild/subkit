import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { loadDraft } from "../draft.ts";
import { TASK_RUN_TOOLS } from "../tools/authoring-palette.ts";
import { getTool, listTools, type ToolContext } from "../tools/index.ts";
import { guardTaskRunTool } from "../tools/sdk-wrap/task-run-guard.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import type { TaskRunMarker } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";
import {
  createRunConversation,
  driveTurn,
  lastPalette,
  markerFor,
  principalOf,
  seedRunnableWorkflow,
  toolCalls,
} from "./task-run-fixtures.ts";
import { freshSignals } from "./turn-signals.ts";

let ctx: ConversationTestCtx;
let owner: ResolvedPrincipal;

const FORBIDDEN_IN_A_RUN = [
  "author_workflow",
  "save_workflow_draft",
  "edit_workflow_patch",
  "update_workflow",
  "delete_workflow",
  "create_schedule",
  "save_connector_draft",
  "update_connector",
  "create_knowledge_source",
  "update_knowledge_source",
  "update_skill",
  "save_learning",
  "create_intake_proposal",
  "export_tenant_package",
  "export_diagnostic_context",
  "apply_package_import",
  "discover_connector_endpoints",
  "rerun_execution",
  "create_api_key",
];

beforeAll(async () => {
  ctx = await createConversationTestCtx("task_run_palette");
  owner = principalOf(ctx, ctx.user_id, "admin");
}, 120_000);

afterAll(async () => {
  await ctx.cleanup();
}, 60_000);

async function toolCtx(conversation_id: string, marker?: TaskRunMarker): Promise<ToolContext> {
  const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: owner.id,
    principal: owner,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: owner.id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async () => {},
    ...(marker ? { task_run: marker } : {}),
  };
}

describe("the palette of a task run is closed", () => {
  test("the model is offered exactly the run palette, whatever skills or surface say", async () => {
    const bound = await seedRunnableWorkflow(ctx, "palette-bound");
    await seedRunnableWorkflow(ctx, "palette-unbound");
    const conversation_id = await createRunConversation(
      ctx,
      owner.id,
      markerFor({ workflow_ids: [bound.id] }),
    );
    await driveTurn(ctx, conversation_id, owner, [{ text: "Nothing to do." }]);
    const palette = lastPalette();
    expect(palette).toEqual([...TASK_RUN_TOOLS, `wf_${bound.slug}`].sort());
    for (const name of FORBIDDEN_IN_A_RUN) expect(palette).not.toContain(name);
    for (const surface of ["web", "mcp", "chat", "sk_headless", "sk_interactive"] as const) {
      const tools = await wrapTools(
        { ...(await toolCtx(conversation_id)), surface },
        freshSignals(),
        [],
        ctx.testDb.db,
        ["workflow-authoring", "connector-creation-guidance", "http-connectors"],
        { save_workflow_draft: "no_confirm" },
        "yolo",
        { ...owner, provider: surface === "chat" ? "chat" : owner.provider },
      );
      expect(Object.keys(tools).sort()).toEqual([...TASK_RUN_TOOLS, `wf_${bound.slug}`].sort());
    }
  }, 120_000);

  test("every name in the run palette is a registered tool", () => {
    const registered = new Set(listTools().map((tool) => tool.name));
    for (const name of TASK_RUN_TOOLS) expect(registered.has(name)).toBe(true);
  });

  test("an authoring tool is refused even when it is called by name", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, markerFor());
    const marker = markerFor();
    for (const name of FORBIDDEN_IN_A_RUN) {
      const tool = getTool(name);
      if (!tool) throw new Error(`fixture names an unknown tool: ${name}`);
      const guarded = guardTaskRunTool(tool, marker);
      const result = await guarded.execute(await toolCtx(conversation_id, marker), {});
      expect(result.ok).toBe(false);
      expect((result as { error_code?: string }).error_code).toBe("task_run_tool_not_allowed");
      const checked = await guarded.precheck?.(await toolCtx(conversation_id, marker), {});
      expect(checked?.ok).toBe(false);
    }
  }, 60_000);

  test("a turn that asks for authoring does not author anything", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, markerFor());
    await driveTurn(
      ctx,
      conversation_id,
      owner,
      [{ text: "I cannot build workflows inside a task run." }],
      "Build a new workflow that mails the report and save it.",
    );
    const palette = lastPalette();
    expect(palette).not.toContain("author_workflow");
    expect(palette).not.toContain("save_workflow_draft");
    expect((await toolCalls(ctx, conversation_id)).map((row) => row.tool)).toEqual([]);
  }, 120_000);

  test("a run conversation without a principal offers no way to act", async () => {
    const bound = await seedRunnableWorkflow(ctx, "palette-no-principal");
    const marker = markerFor({ workflow_ids: [bound.id] });
    const conversation_id = await createRunConversation(ctx, owner.id, marker);
    const base = await toolCtx(conversation_id);
    const tools = await wrapTools(base, freshSignals(), [], ctx.testDb.db, [], {}, "yolo", null);
    expect(Object.keys(tools).filter((name) => name.startsWith("wf_"))).toEqual([]);
    expect(base.task_run?.sealed).toBe(true);
    expect(base.principal).toBeNull();
    expect(base.permission_mode).toBe("auto");
  }, 60_000);

  test("an ordinary conversation never sees the run-only tool and keeps its authoring tools", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    await driveTurn(ctx, conversation_id, owner, [{ text: "Hello." }]);
    const palette = lastPalette();
    expect(palette).not.toContain("schedule_task_check");
    expect(palette).toContain("open_workflow_draft");
    expect(palette).toContain("update_workflow");
    expect(palette).toContain("save_learning");
    const tool = getTool("schedule_task_check");
    if (!tool) throw new Error("schedule_task_check is not registered");
    const refused = await tool.execute(await toolCtx(conversation_id), {
      in_minutes: 10,
      reason: "later",
    });
    expect(refused).toMatchObject({ ok: false, error_code: "task_run_required" });
  }, 120_000);
});
