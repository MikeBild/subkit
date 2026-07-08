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
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/health") {
        return Response.json({ ok: true, service: "guided-authoring-test" });
      }
      // Serve everything else as 200 OK so connector probes (which
      // hit the seeded base_url after v3.5's create.ts migration to
      // server.public_base_url) terminate quickly instead of bouncing
      // through the request-retry ladder until the test times out.
      return new Response("ok", { status: 200 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  // v3.5: create.ts now reads getConfig().server.public_base_url
  // (was process.env.SUBKIT_PUBLIC_BASE_URL).
  await setConfigKey("server.public_base_url", baseUrl, { force: true });
  process.env.SUBKIT_PUBLIC_BASE_URL = baseUrl;
});

afterAll(async () => {
  server.stop(true);
  await ctx.cleanup();
  // Reset the config singleton + env this suite set in beforeAll. Bun runs
  // files alphabetically, so a leaked `server.public_base_url` would make a
  // later suite's stub-DB dispatch try to mint a portal link and throw. Same
  // config-pollution-across-suites class as the global-pool test race.
  delete process.env.SUBKIT_PUBLIC_BASE_URL;
  _resetConfigForTests();
});

describe("guided authoring conversation loop", () => {
  test("runs connector-first onboarding, pauses for approvals, then commits workflow", async () => {
    const created = await createConversationWithTurn(
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
    // New contract: the LLM never re-issues save_connector_draft itself after
    // confirming — no wrapped tool publishes a confirm marker any more. The
    // harness auto-persists the write the instant the operator's "yes"
    // resolves the elicitation, and the model's next turn moves straight on
    // to editing the workflow. Assert the harness-side persistence directly:
    // the synthetic tool-call row it injected, and the second audit row it
    // tags `reason: auto_persist_on_confirmation`.
    // Two rows share this tool name: the model's real (paused) invocation
    // from turn one, and the harness-injected synthetic result from this
    // resume. Only the latter carries `source: "harness_auto_persist"`.
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
