import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { connectors, conversations } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "./index.ts";
import { requestConnectorReauthTool } from "./request-connector-reauth.ts";

let ctx: ConversationTestCtx;
let conversationId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("req_reauth");
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, owner_id: ctx.user_id, status: "active" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("seed conversation failed");
  conversationId = conversation.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedConnector(opts: {
  slug: string;
  needs_reauth?: boolean;
  auth_type?: "bearer" | "oauth2" | "basic" | "header" | "query" | "none";
  driver?: "http" | "graphql";
  config?: Record<string, unknown>;
}): Promise<{ connector_id: string }> {
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug: opts.slug,
      display_name: opts.slug,
      driver: opts.driver ?? "http",
      environment: "dev",
      auth_type: opts.auth_type ?? "bearer",
      base_url: "https://example.test",
      config: opts.config ?? {},
      needs_reauth: opts.needs_reauth ?? false,
    })
    .returning();
  if (!c) throw new Error("seed connector failed");
  return { connector_id: c.id };
}

function makeToolContext(
  actorId: string | null = ctx.user_id,
  surface?: ToolContext["surface"],
): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    actor_id: actorId,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: actorId,
      actor_type: actorId ? "user" : "system",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    ...(surface ? { surface } : {}),
  };
}

describe("request_connector_reauth — happy path", () => {
  test("connector_id → ok:true with reauth fields", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-happy-id" });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), { connector_id });

    expect(result.ok).toBe(true);
    const data = result.data as {
      connector: string;
      method: string;
      reauth_url: string | null;
      instructions: string;
      needs_reauth: boolean;
    };
    expect(typeof data.connector).toBe("string");
    expect(data.method === "oauth2" || data.method === "portal_setup").toBe(true);
    expect(typeof data.instructions).toBe("string");
    expect(data.instructions.length).toBeGreaterThan(0);
    expect(data.needs_reauth).toBe(false);
  });

  test("slug → ok:true (resolved to connector_id internally)", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-happy-slug" });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), {
      slug: "rr-happy-slug",
    });

    expect(result.ok).toBe(true);
    const data = result.data as { connector: string };
    expect(data.connector).toBe("rr-happy-slug");
    void connector_id;
  });

  test("needs_reauth=true is reflected in the response data", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-flagged", needs_reauth: true });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), { connector_id });

    expect(result.ok).toBe(true);
    const data = result.data as { needs_reauth: boolean };
    expect(data.needs_reauth).toBe(true);
  });
});

type ErrorResult = { ok: false; error_code?: string; message?: string };

describe("request_connector_reauth — cognito USER_PASSWORD_AUTH", () => {
  test("cognito_user_password → in-chat re-issue, never a browser reauth_url", async () => {
    const { connector_id } = await seedConnector({
      slug: "rr-cognito",
      auth_type: "oauth2",
      driver: "graphql",
      needs_reauth: true,
      config: {
        oauth: {
          issuer_url: "https://cognito-idp.eu-central-1.amazonaws.com",
          client_id: "test-client-id",
          token_endpoint: "https://cognito-idp.eu-central-1.amazonaws.com/",
          grant_type: "cognito_user_password",
        },
      },
    });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), { connector_id });

    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.method).toBe("portal_setup");
    expect(data.mode).toBe("credential_re_issue");
    expect(data.grant_type).toBe("cognito_user_password");
    expect("reauth_url" in data).toBe(false);
    expect(String(data.next_prompt).toLowerCase()).toContain("password");
  });
});

describe("request_connector_reauth — MCP surface routes to a secure setup URL (D7)", () => {
  test("non-OAuth connector over MCP → URL elicitation pause, no URL in tool data", async () => {
    await setConfigKey("server.public_base_url", "https://engine.test");
    const { connector_id } = await seedConnector({ slug: "rr-mcp-bearer", auth_type: "bearer" });

    let bound = false;
    const mcpCtx: ToolContext = {
      ...makeToolContext(ctx.user_id, "mcp"),
      setDraft: async () => {
        bound = true;
      },
    };
    const result = await requestConnectorReauthTool.execute(mcpCtx, { connector_id });

    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("awaiting_input");
    expect("setup_url" in data).toBe(false);
    const pauseInput = result.pause?.input as Record<string, unknown>;
    expect(String(pauseInput.setup_url)).toMatch(
      new RegExp(
        `^https://engine\\.test/v1/connectors/${connector_id}/credentials/setup\\?grant=sksg_`,
      ),
    );
    expect(pauseInput.single_use).toBe(true);
    expect(typeof pauseInput.expires_at).toBe("string");
    expect("next_prompt" in data).toBe(false);
    expect(bound).toBe(false);
    expect((pauseInput.commit_intent as { kind?: string }).kind).toBe(
      "credential_reissue_completed",
    );
  });

  test("subkit-cli surface is unchanged — still binds a re-issue draft + instructs ask_user_form", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-cli-bearer", auth_type: "bearer" });
    let bound = false;
    const cliCtx: ToolContext = {
      ...makeToolContext(ctx.user_id, "sk_interactive"),
      setDraft: async () => {
        bound = true;
      },
    };
    const result = await requestConnectorReauthTool.execute(cliCtx, { connector_id });
    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.method).toBe("portal_setup");
    expect("setup_url" in data).toBe(false);
    expect(String(data.next_prompt).toLowerCase()).toContain("ask_user_form");
    expect(bound).toBe(true);
  });

  test("OAuth authorization-code over MCP → URL elicitation pause", async () => {
    await setConfigKey("server.public_base_url", "https://engine.test");
    const { connector_id } = await seedConnector({
      slug: "rr-mcp-oauth",
      auth_type: "oauth2",
      config: {
        oauth: {
          authorization_endpoint: "https://provider.test/oauth/authorize",
          token_endpoint: "https://provider.test/oauth/token",
          client_id: "test-client",
          grant_type: "authorization_code",
        },
      },
    });

    const result = await requestConnectorReauthTool.execute(makeToolContext(ctx.user_id, "mcp"), {
      connector_id,
    });

    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("awaiting_input");
    expect("reauth_url" in data).toBe(false);
    const pauseInput = result.pause?.input as Record<string, unknown>;
    expect(String(pauseInput.authorization_url)).toContain(
      `/v1/connectors/${connector_id}/oauth/start?grant=skog_`,
    );
    expect((pauseInput.commit_intent as { kind?: string }).kind).toBe("oauth_completed");
  });
});

describe("request_connector_reauth — the link opens the connector's own sign-in route", () => {
  async function seedMcpServer(slug: string): Promise<string> {
    const [c] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenant_id,
        slug,
        display_name: slug,
        driver: "mcp",
        environment: "prod",
        auth_type: "oauth2",
        base_url: "https://remote.example.test/mcp",
        config: { mcp: { transport: "http", auth: { kind: "oauth2" } } },
      })
      .returning();
    if (!c) throw new Error("seed connector failed");
    return c.id;
  }

  test("an MCP server's link opens mcp/authorize, never oauth/start", async () => {
    await setConfigKey("server.public_base_url", "https://engine.test");
    const connector_id = await seedMcpServer("rr-mcp-server");

    const result = await requestConnectorReauthTool.execute(makeToolContext(), { connector_id });

    expect(result.ok).toBe(true);
    const data = result.data as { method: string; reauth_url: string };
    expect(data.method).toBe("oauth2");
    const url = new URL(data.reauth_url);
    expect(url.pathname).toBe(`/v1/connectors/${connector_id}/mcp/authorize`);
    expect(url.searchParams.get("grant")).toStartWith("skog_");
  });

  test("over MCP the paused elicitation carries the same mcp/authorize link", async () => {
    await setConfigKey("server.public_base_url", "https://engine.test");
    const connector_id = await seedMcpServer("rr-mcp-server-mcp");

    const result = await requestConnectorReauthTool.execute(makeToolContext(ctx.user_id, "mcp"), {
      connector_id,
    });

    const pauseInput = result.pause?.input as Record<string, unknown>;
    expect(String(pauseInput.authorization_url)).toContain(
      `/v1/connectors/${connector_id}/mcp/authorize?grant=skog_`,
    );
  });
});

describe("request_connector_reauth — error envelopes", () => {
  test("neither connector_id nor slug → invalid_input", async () => {
    const result = (await requestConnectorReauthTool.execute(makeToolContext(), {})) as ErrorResult;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("invalid_input");
    expect(typeof result.message).toBe("string");
  });

  test("unknown slug → connector_not_found", async () => {
    const result = (await requestConnectorReauthTool.execute(makeToolContext(), {
      slug: "no-such-connector-slug-xyz",
    })) as ErrorResult;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("connector_not_found");
  });

  test("unknown connector_id (valid UUID not in DB) → connector_not_found", async () => {
    const result = (await requestConnectorReauthTool.execute(makeToolContext(), {
      connector_id: crypto.randomUUID(), // allow-random: valid UUID not in DB
    })) as ErrorResult;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("connector_not_found");
  });
});
