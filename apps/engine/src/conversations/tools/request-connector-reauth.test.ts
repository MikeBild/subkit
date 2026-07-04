// Tests for the request_connector_reauth conversation tool.
//
// Follows the call-connector.test.ts pattern: seeds connectors via direct DB
// inserts, constructs a ToolContext via makeToolContext, and exercises the
// tool's execute() function directly — no HTTP boundary.
//
// Coverage:
//   - happy path: connector_id → ok:true, correct reauth fields returned.
//   - slug resolution: slug → ok:true (resolved to connector_id internally).
//   - neither id nor slug → invalid_input.
//   - unknown slug → connector_not_found.
//   - unknown connector_id (UUID not in DB) → connector_not_found.
//   - needs_reauth flag reflected in data.needs_reauth.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { connectors } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "./index.ts";
import { requestConnectorReauthTool } from "./request-connector-reauth.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("req_reauth");
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
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

// ---------------------------------------------------------------------------
// happy paths
// ---------------------------------------------------------------------------

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
    // needs_reauth reflects the current DB state (false for a healthy connector).
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
    void connector_id; // verified via slug match
  });

  test("needs_reauth=true is reflected in the response data", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-flagged", needs_reauth: true });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), { connector_id });

    expect(result.ok).toBe(true);
    const data = result.data as { needs_reauth: boolean };
    expect(data.needs_reauth).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error envelopes
// ---------------------------------------------------------------------------

type ErrorResult = { ok: false; error_code?: string; message?: string };

describe("request_connector_reauth — cognito USER_PASSWORD_AUTH", () => {
  // Regression: a Cognito (cognito_user_password) connector must NOT get a
  // browser authorization-code link — the password isn't stored, there is no
  // authorization endpoint, and the dance throws "unexpected HTTP response
  // status code", burning the grant and showing a misleading "link used up"
  // page. It must route to the in-chat email+password re-issue instead.
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
    // The bug was minting a browser link — assert there is none.
    expect("reauth_url" in data).toBe(false);
    expect(String(data.next_prompt).toLowerCase()).toContain("password");
  });
});

describe("request_connector_reauth — MCP surface routes to a secure setup URL (D7)", () => {
  // Over MCP the in-chat ask_user_form credential re-issue is unreachable
  // (a secret must never be collected as chat text). The non-OAuth path must
  // instead return the secure `/v1/connectors/:id/credentials` setup URL and
  // NOT bind a re-issue draft nor instruct ask_user_form.
  test("non-OAuth connector over MCP → method:portal_setup with a bare setup_url", async () => {
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
    expect(data.method).toBe("portal_setup");
    expect(data.mode).toBe("credential_re_issue");
    expect(String(data.setup_url)).toBe(
      `https://engine.test/v1/connectors/${connector_id}/credentials`,
    );
    // No in-chat form and no draft binding over MCP.
    expect("next_prompt" in data).toBe(false);
    expect(bound).toBe(false);
    expect(String(data.instructions).toLowerCase()).toContain(
      "never ask the user to paste the secret in chat",
    );
  });

  test("sk-cli surface is unchanged — still binds a re-issue draft + instructs ask_user_form", async () => {
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
