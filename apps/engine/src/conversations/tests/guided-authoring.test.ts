import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createConversation, getConversation, respondElicitation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("guided_authoring");
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/health") {
        return Response.json({ ok: true, service: "guided-authoring-test" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  process.env.SUBKIT_PUBLIC_BASE_URL = baseUrl;
});

afterAll(async () => {
  server.stop(true);
  await ctx.cleanup();
});

describe("guided authoring conversation loop", () => {
  test("runs connector-first onboarding, pauses for approvals, then commits workflow", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "subkit engine onboarding",
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

    const resumedSave = await respondElicitation(
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
    expect(
      resumedSave.result.events.some(
        (event) => event.type === "tool_call_start" && event.tool === "save_connector_draft",
      ),
    ).toBe(true);
    expect(
      resumedSave.result.events.some(
        (event) => event.type === "tool_call_start" && event.tool === "build_workflow",
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

    const resumedCommit = await respondElicitation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        elicitation_id: resumedSave.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumedCommit.result.status).toBe("committed");
    expect(resumedCommit.result.committed_workflow_id).toBeTruthy();

    const detail = await getConversation(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.status).toBe("committed");
    expect(detail?.conversation.target_connector_id).toBeTruthy();
    expect(detail?.conversation.target_workflow_id).toBeTruthy();
    expect(detail?.draft?.connector?.name).toBe("Subkit Engine");
    expect(detail?.draft?.connector?.saved_connector_id).toBeTruthy();
    expect(detail?.draft?.connector?.latest_probe?.summary).toContain("Probe succeeded");
    // Post-hart-cut: dry_run_step routes through runSingleStep, so the
    // summary now reads "Ran step `health` (request) in Nms." The word
    // "Previewed" is gone alongside preview.ts.
    expect(detail?.draft?.latest_preview?.summary).toContain("Ran step");
    expect(detail?.draft?.latest_preview?.summary).toContain("health");
  });
});
