import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, setConfigKey } from "../../config/loader.ts";
import { auditLog, conversationToolCalls } from "../../db/schema/index.ts";
import { getConversation } from "../service.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "./setup.ts";

let ctx: ConversationTestCtx;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("guided_authoring");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "guided-authoring-test" });
      }
      return new Response("ok", { status: 200 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  await setConfigKey("server.public_base_url", baseUrl, { force: true });
});

afterAll(async () => {
  server.stop(true);
  await ctx.cleanup();
  _resetConfigForTests();
});

describe("guided authoring conversation loop", () => {
  test("runs connector-first onboarding, pauses for approvals, then commits workflow", async () => {
    const created = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "subkit engine onboarding",
        permission_mode: "ask",
      },
      ctx.testDb.db,
    );
    expect(created.result.status).toBe("awaiting_input");
    const firstTools = created.result.events
      .filter((event) => event.type === "tool_call_start")
      .map((event) => event.tool);
    expect(firstTools).toEqual(
      expect.arrayContaining([
        "suggest_connector_templates",
        "start_connector_from_description",
        "validate_connector_draft",
        "probe_connector_draft",
        "save_connector_draft",
      ]),
    );
    expect(created.result.pending_elicitation_id).toBeDefined();
    expect(
      created.result.events.some(
        (event) =>
          event.type === "elicit_request" &&
          event.tool_name === "ask_user_confirm" &&
          event.summary.includes("save_connector_draft"),
      ),
    ).toBe(true);

    const resumedSave = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        elicitation_id: created.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumedSave.result.status).toBe("awaiting_input");
    expect(resumedSave.result.pending_elicitation_id).toBeTruthy();
    const autoPersistCalls = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, ctx.tenant_id),
          eq(conversationToolCalls.conversation_id, created.conversation.id),
          eq(conversationToolCalls.tool, "save_connector_draft"),
        ),
      );
    const harnessCall = autoPersistCalls.find(
      (row) =>
        typeof row.output === "object" &&
        row.output !== null &&
        (row.output as Record<string, unknown>).source === "harness_auto_persist",
    );
    expect(harnessCall).toBeDefined();
    const autoPersistOutput = harnessCall!.output as Record<string, unknown>;
    expect(autoPersistOutput.ok).toBe(true);
    const autoPersistAudit = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.reason, "auto_persist_on_confirmation"),
        ),
      );
    const connectorAutoPersist = autoPersistAudit.find(
      (row) =>
        typeof row.metadata === "object" &&
        row.metadata !== null &&
        (row.metadata as Record<string, unknown>).commit_intent_kind === "save_connector_draft",
    );
    expect(connectorAutoPersist).toBeDefined();
    expect(
      resumedSave.result.events.some(
        (event) => event.type === "tool_call_start" && event.tool === "edit_workflow_patch",
      ),
    ).toBe(true);
    expect(
      resumedSave.result.events.some(
        (event) => event.type === "tool_call_start" && event.tool === "dry_run_step",
      ),
    ).toBe(true);
    expect(
      resumedSave.result.events.some(
        (event) =>
          event.type === "elicit_request" &&
          event.tool_name === "ask_user_confirm" &&
          event.summary.toLowerCase().includes("commit"),
      ),
    ).toBe(true);

    const resumedCommit = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        elicitation_id: resumedSave.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumedCommit.result.status).toBe("active");
    expect(resumedCommit.result.committed_workflow_id).toBeTruthy();

    const detail = await getConversation(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.status).toBe("active");
    expect(detail?.conversation.target_connector_id).toBeTruthy();
    expect(detail?.conversation.target_workflow_id).toBeTruthy();
    expect(detail?.draft?.connector?.name).toBe("Subkit Engine");
    expect(detail?.draft?.connector?.saved_connector_id).toBeTruthy();
    expect(detail?.draft?.connector?.latest_probe?.summary).toContain("Probe succeeded");
    expect(detail?.draft?.latest_preview?.summary).toContain("Ran step");
    expect(detail?.draft?.latest_preview?.summary).toContain("health");
  });
});
