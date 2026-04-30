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
        await new Promise((resolve) => setTimeout(resolve, 250)); // allow-wall-clock: legacy; review before changing
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
    const toolCtx = await createToolCtx();
    const res = await suggestConnectorTemplatesTool.execute(toolCtx.base, {
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
      connector: { template_slug: string | null; template_name: string | null; auth_type: string };
      matched_template: { slug: string; score: number } | null;
    };
    expect(data.connector.template_slug).toBe("github");
    expect(data.connector.template_name).toBeTruthy();
    expect(data.connector.auth_type).toBeTruthy();
    expect(data.matched_template?.score).toBeGreaterThan(0);
  });

  test("start_connector_from_description prefers URL-pattern match over text match (AppSync Cognito)", async () => {
    // Pre-fix the LLM passing description="AWS AppSync GraphQL" + a
    // matching url got handed a generic graphql template that hardcoded
    // `auth_type=header`, forcing the operator through a credential
    // dance: ask for username+password (Cognito), reject those because
    // the draft says header-auth, ask for x-api-key. URL match now
    // wins so the operator hits `appsync-cognito` (oauth2 +
    // cognito_user_password) on the first turn.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AWS AppSync GraphQL",
      description: "AWS AppSync GraphQL endpoint",
      base_url: "https://qjzi627ik5b4xjya4cibaba6ai.appsync-api.eu-central-1.amazonaws.com/graphql",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; auth_type: string };
      matched_template: { slug: string; match_kind: "url" | "text" } | null;
    };
    expect(data.connector.template_slug).toBe("appsync-cognito");
    expect(data.connector.auth_type).toBe("oauth2");
    expect(data.matched_template?.match_kind).toBe("url");
  });

  test("URL match still wins when LLM mis-guesses auth_type as aws_sigv4", async () => {
    // Reproduces the regression in session 3f81fb2a. The LLM sees an
    // AppSync hostname and unconditionally guesses `aws_sigv4`. URL
    // match returns BOTH `appsync-cognito` and `appsync-iam`. Pre-fix
    // the guard "args.auth_type must be in URL-match's auth_options"
    // disqualified cognito (no aws_sigv4 option), fell back to text
    // match which picked `appsync-iam` — auth=aws_sigv4 baked into the
    // draft. Now we bias-by-auth-type-hint among URL matches: pick the
    // template whose auth_options accept the LLM's guess.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AWS AppSync GraphQL",
      description: "AWS AppSync GraphQL endpoint",
      base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
      environment: "dev",
      auth_type: "aws_sigv4", // mis-guess — operator actually has user+pass
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; auth_type: string };
      matched_template: { slug: string; match_kind: "url" | "text" } | null;
    };
    // SigV4-compatible URL match → appsync-iam wins (the auth_type
    // hint biased the URL-match selection).
    expect(data.connector.template_slug).toBe("appsync-iam");
    expect(data.connector.auth_type).toBe("aws_sigv4");
    expect(data.matched_template?.match_kind).toBe("url");
  });

  test("URL match falls back to first candidate when LLM auth_type matches no URL template", async () => {
    // LLM mis-guesses again, this time with an auth_type that NO
    // AppSync template supports. URL match should still win — first
    // candidate (alphabetical: appsync-cognito), auth_type forced to
    // template's primary (oauth2). Operator's URL is ground truth.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AWS AppSync GraphQL",
      description: "AWS AppSync GraphQL endpoint",
      base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
      environment: "dev",
      auth_type: "bearer", // not in either appsync template's auth_options
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; auth_type: string };
      matched_template: { slug: string; match_kind: "url" | "text" } | null;
    };
    expect(data.connector.template_slug).toBe("appsync-cognito");
    expect(data.connector.auth_type).toBe("oauth2"); // template wins, not LLM's bearer
    expect(data.matched_template?.match_kind).toBe("url");
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

  test("save_connector_draft blocks without a successful probe, then persists after probe", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Force Save API",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    await inspectConnectorDraftTool.execute(toolCtx.base, {});
    await validateConnectorDraftTool.execute(toolCtx.base, {});
    const blocked = await saveConnectorDraftTool.execute(toolCtx.base, {});
    expect(blocked.ok).toBe(false);
    expect((blocked.data as { error_code: string }).error_code).toBe("connector_not_ready");

    await probeConnectorDraftTool.execute(toolCtx.base, { method: "GET", path: "/health" });
    const saved = await saveConnectorDraftTool.execute(toolCtx.base, {});
    expect(saved.ok).toBe(true);
    const connector = (saved.data as { connector: { id: string; display_name: string } }).connector;
    expect(connector.display_name).toBe("Force Save API");
    expect(connector.id).toBeTruthy();
  });
});
