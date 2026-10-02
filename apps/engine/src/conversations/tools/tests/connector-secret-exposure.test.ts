// A tool result is read by a model and, over MCP, by that model's client. The
// connector view the tools read carries the OAuth client secret and the
// connection-string password for the server's own use, so no tool may hand
// the view on: `get_connector` returns the public projection, a draft
// hydrated from a saved connector holds the mask, and a template dry run does
// not resolve a connector token into its result. `update_connector`, fed the
// projection back, must keep the secret the mask stands for.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CONNECTOR_SECRET_MASK,
  createConnector,
  getConnector,
  resolveConnectorOAuthConfig,
} from "../../../connectors/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { hydrateDraftFromSavedConnector } from "../../authoring-state/normalize.ts";
import { connectorFieldPatch } from "../../persistence/save-connector.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import { dryRunTransformTool } from "../dry-run-transform.ts";
import { getConnectorTool } from "../generated/connectors.ts";
import { updateConnectorTool } from "../generated/writes/update-connector.ts";
import type { ToolContext } from "../index.ts";

// Fixture markers, not credentials.
const CLIENT_SECRET = "fixture-client-secret-not-real";
const DSN_SECRET = "fixture-dsn-secret-not-real";

const nextUuid = createDeterministicUuidFactory(1);

let ctx: ConversationTestCtx;
let oauthConnectorId: string;
let postgresConnectorId: string;

function toolContext(): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: nextUuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("get_connector_masking");
  const oauth = await createConnector(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      input: {
        name: "Acme OAuth",
        slug: "acme-oauth",
        driver: "http",
        environment: "dev",
        base_url: "https://api.acme.test/v2",
        auth_type: "oauth2",
        config: {
          timeout_ms: 5000,
          oauth: {
            issuer_url: "https://login.acme.test",
            token_endpoint: "https://login.acme.test/token",
            scope: "read:things",
            client_id: "acme-client-id",
            client_secret: CLIENT_SECRET,
          },
        },
      },
    },
    ctx.testDb.db,
  );
  const pg = await createConnector(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      input: {
        name: "Acme DB",
        slug: "acme-db",
        driver: "postgres",
        environment: "dev",
        auth_type: "none",
        dsn: `postgres://app_user:${DSN_SECRET}@db.acme.test:5432/app`,
      },
    },
    ctx.testDb.db,
  );
  oauthConnectorId = oauth.id;
  postgresConnectorId = pg.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("get_connector returns the public projection", () => {
  test("the OAuth client secret is masked and the config around it is readable", async () => {
    const result = await getConnectorTool.execute(toolContext(), { id: oauthConnectorId });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    const connector = (result.data as { connector: { config: { oauth: Record<string, unknown> } } })
      .connector;
    expect(connector.config.oauth).toEqual({
      issuer_url: "https://login.acme.test",
      token_endpoint: "https://login.acme.test/token",
      scope: "read:things",
      client_id: "acme-client-id",
      client_secret: CONNECTOR_SECRET_MASK,
    });
  });

  test("the connection-string password is masked, user and host are not", async () => {
    const result = await getConnectorTool.execute(toolContext(), { id: postgresConnectorId });
    expect(JSON.stringify(result)).not.toContain(DSN_SECRET);
    expect((result.data as { connector: { dsn: string } }).connector.dsn).toBe(
      `postgres://app_user:${CONNECTOR_SECRET_MASK}@db.acme.test:5432/app`,
    );
  });
});

describe("update_connector fed a get_connector result keeps the secret", () => {
  test("the mask in the returned config is read as 'keep the stored value'", async () => {
    const read = await getConnectorTool.execute(toolContext(), { id: oauthConnectorId });
    const config = (read.data as { connector: { config: Record<string, unknown> } }).connector
      .config;
    const updated = await updateConnectorTool.execute(toolContext(), {
      id: oauthConnectorId,
      config: { ...config, timeout_ms: 9000 },
    });
    expect(updated.ok).toBe(true);
    expect(JSON.stringify(updated)).not.toContain(CLIENT_SECRET);

    const view = await getConnector(ctx.tenant_id, oauthConnectorId, ctx.testDb.db);
    if (!view) throw new Error("connector vanished");
    expect(view.config.timeout_ms).toBe(9000);
    // The same resolution `oauth/start` and the refresh worker go through.
    const oauth = await resolveConnectorOAuthConfig(ctx.testDb.db, ctx.tenant_id, view);
    expect(oauth?.client_secret).toBe(CLIENT_SECRET);
  });
});

describe("dry_run_transform does not look a connector token up", () => {
  const token = `\${connector.acme-oauth.config.oauth.client_secret}`;

  test("a connector config token is refused instead of resolved into the result", async () => {
    const result = await dryRunTransformTool.execute(toolContext(), {
      expression: `secret=${token}`,
      sample_data: { input: {} },
      dialect: "template",
    });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    expect(result.ok).toBe(false);
    const error = (result.data as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("placeholder_unresolved");
    expect(error.message).toContain(token);
  });
});

describe("a draft hydrated from a saved connector is conversation state", () => {
  test("it carries the mask, so every tool that echoes the draft is clean", async () => {
    const db = ctx.testDb.db;
    const oauth = await getConnector(ctx.tenant_id, oauthConnectorId, db);
    const pg = await getConnector(ctx.tenant_id, postgresConnectorId, db);
    if (!oauth || !pg) throw new Error("connector vanished");
    const pgDraft = hydrateDraftFromSavedConnector(pg);
    const text = JSON.stringify([hydrateDraftFromSavedConnector(oauth), pgDraft]);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(DSN_SECRET);
    // The masked dsn is the stored value, not an edit to write back.
    expect(connectorFieldPatch(pgDraft, pg)).toEqual({});
  });
});
