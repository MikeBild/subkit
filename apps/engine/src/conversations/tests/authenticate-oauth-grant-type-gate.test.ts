// authenticate_oauth — grant-type gate tests.
//
// Covers the guard that fires AFTER `resolveConnectorOAuthConfig` resolves
// `cfg` but BEFORE `startAuthorizationCode` is called:
//
//   - `cognito_user_password` grant  → wrong_reauth_flow error,
//     next_best_actions includes "request_connector_reauth",
//     startAuthorizationCode is NEVER called.
//   - `client_credentials_json` grant → same wrong_reauth_flow shape.
//   - `authorization_code` grant      → proceeds past the gate
//     (no wrong_reauth_flow returned).
//
// No live OAuth provider is contacted. The test seeds minimal connector rows
// that make `resolveConnectorOAuthConfig` return the desired grant_type, and
// mocks `startAuthorizationCode` so the authorization_code path's network
// call is intercepted. The DB-pause branch (no bridge) is exercised so we
// never need a live elicitation bridge.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import * as oauthClient from "../../credentials/oauth2/client.ts";
import { connectors, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { authenticateOAuthTool } from "../tools/authenticate-oauth.ts";
import { WRONG_REAUTH_FLOW } from "../tools/error-codes.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;
let priorBaseUrl = "";

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* not yet loaded */
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-aog-gate-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/aog-gate", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  // Set public_base_url so buildOAuthRedirectUri resolves for the
  // authorization_code passthrough test (same pattern as elicitation test).
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", "https://engine.test.example", { force: true });

  ctx = await createTestDb("authenticate_oauth_grant_gate");

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-aog-gate", display_name: "T-AOG-GATE" })
    .returning();
  tenant_id = t!.id;

  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = conv!.id;
});

afterAll(async () => {
  await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  await ctx.cleanup();
});

/**
 * Seed a connector whose `config.oauth.grant_type` makes
 * `resolveConnectorOAuthConfig` return the given grant_type. The connector
 * must be auth_type=oauth2 so the OAuth config resolution path is taken.
 */
async function seedOAuthConnector(slug: string, grantType: string): Promise<string> {
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://api.example.test",
      config: {
        oauth: {
          grant_type: grantType,
          // Minimal fields so resolveConnectorOAuthConfig doesn't 404.
          issuer_url: "https://issuer.example.test",
          client_id: "cid",
          client_secret: "csec",
          scope: "read",
        },
      },
    })
    .returning({ id: connectors.id });
  return c!.id;
}

function buildToolCtx(connectorId: string): ToolContext {
  const draftRef: { current: DraftDocument } = {
    current: {
      mode: "connector_authoring",
      connector: { name: connectorId, slug: connectorId, driver: "http", environment: "dev" },
      workflow: { name: "", steps: [] },
    } as DraftDocument,
  };
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: connectorId,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => draftRef.current,
    setDraft: async (next) => {
      draftRef.current = next;
    },
    abortSignal: new AbortController().signal,
  };
}

describe("authenticate_oauth — grant-type gate: cognito_user_password", () => {
  test("returns wrong_reauth_flow with next_best_actions=[request_connector_reauth]", async () => {
    const connectorId = await seedOAuthConnector("cog-gate-test", "cognito_user_password");
    const startSpy = spyOn(oauthClient, "startAuthorizationCode");

    const result = await authenticateOAuthTool.execute(buildToolCtx(connectorId), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code: string;
      message: string;
      next_best_actions: string[];
    };
    expect(data.error_code).toBe(WRONG_REAUTH_FLOW);
    expect(data.next_best_actions).toContain("request_connector_reauth");

    // startAuthorizationCode must NEVER be called for this grant type.
    expect(startSpy).not.toHaveBeenCalled();

    startSpy.mockRestore();
  });

  test("message describes the cognito flow and mentions authenticate_oauth is wrong", async () => {
    const connectorId = await seedOAuthConnector("cog-gate-msg", "cognito_user_password");

    const result = await authenticateOAuthTool.execute(buildToolCtx(connectorId), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error_code: string; message: string };
    expect(data.error_code).toBe(WRONG_REAUTH_FLOW);
    // The message must guide the caller away from authenticate_oauth.
    expect(data.message.toLowerCase()).toMatch(/cognito|user_password|request_connector_reauth/i);
  });
});

describe("authenticate_oauth — grant-type gate: client_credentials_json", () => {
  test("returns wrong_reauth_flow with next_best_actions=[request_connector_reauth]", async () => {
    const connectorId = await seedOAuthConnector("ccj-gate-test", "client_credentials_json");
    const startSpy = spyOn(oauthClient, "startAuthorizationCode");

    const result = await authenticateOAuthTool.execute(buildToolCtx(connectorId), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code: string;
      message: string;
      next_best_actions: string[];
    };
    expect(data.error_code).toBe(WRONG_REAUTH_FLOW);
    expect(data.next_best_actions).toContain("request_connector_reauth");

    // startAuthorizationCode must NEVER be called for this grant type.
    expect(startSpy).not.toHaveBeenCalled();

    startSpy.mockRestore();
  });

  test("message describes the M2M flow and mentions authenticate_oauth is wrong", async () => {
    const connectorId = await seedOAuthConnector("ccj-gate-msg", "client_credentials_json");

    const result = await authenticateOAuthTool.execute(buildToolCtx(connectorId), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error_code: string; message: string };
    expect(data.error_code).toBe(WRONG_REAUTH_FLOW);
    expect(data.message.toLowerCase()).toMatch(/client.credentials|m2m|request_connector_reauth/i);
  });
});

describe("authenticate_oauth — grant-type gate: authorization_code passes through", () => {
  test("authorization_code grant does NOT return wrong_reauth_flow", async () => {
    const connectorId = await seedOAuthConnector("authcode-passthrough", "authorization_code");

    // Mock startAuthorizationCode to avoid a real network call.
    // If the gate were erroneously triggered, the mock is never reached
    // and the test verifies via the result shape.
    const startSpy = spyOn(oauthClient, "startAuthorizationCode").mockResolvedValue({
      authorization_url: "https://issuer.example.test/authorize?client_id=cid&state=stub",
      state: "stub-state-token",
      code_verifier: "stub-verifier",
    });

    const result = await authenticateOAuthTool.execute(buildToolCtx(connectorId), {
      connector_id: connectorId,
    });

    // The gate must NOT trigger wrong_reauth_flow.
    const data = result.data as Record<string, unknown>;
    expect(data.error_code).not.toBe(WRONG_REAUTH_FLOW);

    // startAuthorizationCode was called — the code reached the dance
    // setup phase (gate was bypassed correctly).
    expect(startSpy).toHaveBeenCalledTimes(1);

    startSpy.mockRestore();
  });
});
