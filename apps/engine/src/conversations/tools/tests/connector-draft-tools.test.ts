import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { inspectConnectorDraftTool } from "../inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../probe-connector-draft.ts";
import { saveConnectorDraftTool } from "../save-connector-draft.ts";
import { startConnectorFromDescriptionTool } from "../start-connector-from-description.ts";
import { startConnectorFromTemplateTool } from "../start-connector-from-template.ts";
import { suggestConnectorTemplatesTool } from "../suggest-connector-templates.ts";
import { updateConnectorDraftTool } from "../update-connector-draft.ts";
import { validateConnectorDraftTool } from "../validate-connector-draft.ts";

let ctx: ConversationTestCtx;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("connector_draft_tools");
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "local-probe", path: url.pathname });
      }
      if (url.pathname === "/slow") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return Response.json({ ok: true, delayed: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await ctx.cleanup();
});

async function createToolCtx() {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "connector-draft-test",
    },
    ctx.testDb.db,
  );
  let draft: DraftDocument = createEmptyDraftDocument();
  return {
    conversation_id: created.conversation.id,
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
    base: {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: created.conversation.id,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      engineClient: {} as never,
      getDraft: () => draft,
      setDraft: async (next: DraftDocument) => {
        draft = next;
      },
    },
  };
}

describe("connector draft tools", () => {
  test("suggest_connector_templates returns optional matches", async () => {
    const res = await suggestConnectorTemplatesTool.execute({} as never, {
      query: "github",
      limit: 3,
    });
    expect(res.ok).toBe(true);
    expect((res.data as { suggested: boolean }).suggested).toBe(true);
    expect(
      (res.data as { templates: Array<{ slug: string; allowed_auth_types: string[] }> })
        .templates[0]?.allowed_auth_types.length,
    ).toBeGreaterThan(0);
  });

  test("start + validate connector draft captures missing fields", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Quokka Ledger",
      description: "Private ledger sync endpoint for backoffice use",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    });
    const inspected = await inspectConnectorDraftTool.execute(toolCtx.base, {});
    expect(inspected.ok).toBe(true);
    expect((inspected.data as { connector: { name: string } }).connector.name).toBe(
      "Quokka Ledger",
    );

    const validated = await validateConnectorDraftTool.execute(toolCtx.base, {});
    expect(validated.ok).toBe(false);
    const validation = (validated.data as { validation: { missing_fields: string[] } }).validation;
    expect(validation.missing_fields.some((field) => field.startsWith("base_url"))).toBe(true);
  });

  test("start_connector_from_description matches a built-in template when the description is clear", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "GitHub",
      description: "Connect GitHub repositories and issues over the GitHub API",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_id: string | null; template_name: string | null; auth_type: string };
      matched_template: { slug: string; score: number } | null;
    };
    expect(data.connector.template_id).toBe("github");
    expect(data.connector.template_name).toBeTruthy();
    expect(data.connector.auth_type).toBeTruthy();
    expect(data.matched_template?.score).toBeGreaterThan(0);
  });

  test("start_connector_from_template reports unresolved endpoint placeholders as missing fields", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromTemplateTool.execute(toolCtx.base, {
      template_slug: "shopify",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { required_fields: string[] };
      validation: { missing_fields: string[]; errors: Array<{ path: string; message: string }> };
    };
    expect(data.connector.required_fields).toContain("shop");
    expect(data.validation.missing_fields).toContain("base_url.shop");
    expect(data.validation.errors.some((error) => error.path === "base_url")).toBe(false);
  });

  test("probe_connector_draft stores the latest probe summary", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "zxqprobe",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    const probe = await probeConnectorDraftTool.execute(toolCtx.base, {
      method: "GET",
      path: "/health",
    });
    expect(probe.ok).toBe(true);
    const inspected = await inspectConnectorDraftTool.execute(toolCtx.base, {});
    const connector = (inspected.data as { connector: { latest_probe: { summary: string } } })
      .connector;
    expect(connector.latest_probe.summary).toContain("Probe succeeded");
  });

  test("probe_connector_draft times out cleanly and records probe_timeout", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "zxqslow",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    const probe = await probeConnectorDraftTool.execute(toolCtx.base, {
      method: "GET",
      path: "/slow",
      timeout_ms: 100,
    });
    expect(probe.ok).toBe(false);
    const latestProbe = (probe.data as { latest_probe: { failure_code: string; summary: string } })
      .latest_probe;
    expect(latestProbe.failure_code).toBe("probe_timeout");
    expect(latestProbe.summary).toContain("timed out");
  });

  test("save_connector_draft blocks without a successful probe unless forced, then persists", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Force Save API",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    const blocked = await saveConnectorDraftTool.execute(toolCtx.base, { force: false });
    expect(blocked.ok).toBe(false);
    expect((blocked.data as { error: string }).error).toBe("probe_required");

    await updateConnectorDraftTool.execute(toolCtx.base, { base_url: baseUrl });
    await probeConnectorDraftTool.execute(toolCtx.base, { method: "GET", path: "/health" });
    const saved = await saveConnectorDraftTool.execute(toolCtx.base, { force: false });
    expect(saved.ok).toBe(true);
    const connector = (saved.data as { connector: { id: string; display_name: string } }).connector;
    expect(connector.display_name).toBe("Force Save API");
    expect(connector.id).toBeTruthy();
  });
});
