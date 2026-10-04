import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { query as gqlQuery } from "../../apps/engine/src/connectors/drivers/graphql.ts";
import {
  __resetOAuth2CacheForTests,
  runCognitoUserPasswordGrant,
} from "../../apps/engine/src/credentials/oauth2/client.ts";
import { upsertCredential } from "../../apps/engine/src/credentials/service.ts";
import { connectors, tenants } from "../../apps/engine/src/db/schema/index.ts";
import { createTestDb, type TestDb } from "../../apps/engine/src/db/tests/setup.ts";
import { getTestNow } from "../../apps/engine/src/test-helpers/determinism/clock.ts";

const TEST_NOW_MS = getTestNow();

const live = process.env.APPSYNC_COGNITO_E2E === "1";
const EMAIL = process.env.APPSYNC_E2E_EMAIL ?? "";
const PASSWORD = process.env.APPSYNC_E2E_PASSWORD ?? "";
const CLIENT_ID = process.env.APPSYNC_E2E_CLIENT_ID ?? "";
const REGION = process.env.APPSYNC_E2E_REGION ?? "eu-central-1";
const APPSYNC_URL = process.env.APPSYNC_E2E_URL ?? "";

const liveTest = (name: string, fn: () => Promise<void>): void => {
  test.skipIf(!live)(`${name} (set APPSYNC_COGNITO_E2E=1 to run)`, fn, 60_000);
};

let ctx: TestDb;
let tenantId: string;
let connectorId: string;

beforeAll(async () => {
  if (!live) return;
  if (!EMAIL || !PASSWORD || !CLIENT_ID || !APPSYNC_URL) {
    throw new Error(
      "APPSYNC_COGNITO_E2E=1 requires APPSYNC_E2E_EMAIL / _PASSWORD / _CLIENT_ID / _URL",
    );
  }
  __resetOAuth2CacheForTests();
  ctx = await createTestDb("appsync_cognito_e2e");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "appsync-e2e", display_name: "AppSync E2E" })
    .returning();
  tenantId = t!.id;
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "appsync-cognito-e2e",
      display_name: "AppSync E2E",
      driver: "graphql",
      environment: "dev",
      auth_type: "oauth2",
      base_url: APPSYNC_URL,
      config: { endpoint: APPSYNC_URL, aws_region: REGION, oauth: { client_id: CLIENT_ID } },
    })
    .returning();
  connectorId = c!.id;
}, 30_000);

afterAll(async () => {
  if (live && ctx) await ctx.cleanup();
}, 30_000);

describe("AppSync + Cognito (live)", () => {
  liveTest(
    "Cognito InitiateAuth returns IdToken; AppSync accepts it as raw Authorization header",
    async () => {
      const bundle = await runCognitoUserPasswordGrant({
        region: REGION,
        client_id: CLIENT_ID,
        username: EMAIL,
        password: PASSWORD,
      });

      expect(bundle.access_token.startsWith("eyJ")).toBe(true);
      expect(bundle.token_type).toBe("none");
      expect(typeof bundle.refresh_token).toBe("string");
      expect(bundle.expires_at).toBeInstanceOf(Date);
      expect(bundle.expires_at!.getTime()).toBeGreaterThan(TEST_NOW_MS);

      const res = await fetch(APPSYNC_URL, {
        method: "POST",
        headers: {
          authorization: bundle.access_token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: "{ __schema { queryType { name fields { name } } } }",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data?: { __schema?: { queryType?: { name: string; fields: Array<{ name: string }> } } };
      };
      expect(body.data?.__schema?.queryType?.name).toBe("Query");
      expect(body.data?.__schema?.queryType?.fields.length ?? 0).toBeGreaterThan(0);
    },
  );

  liveTest(
    "engine GraphQL driver routes the persisted oauth2 credential through to AppSync",
    async () => {
      const bundle = await runCognitoUserPasswordGrant({
        region: REGION,
        client_id: CLIENT_ID,
        username: EMAIL,
        password: PASSWORD,
      });
      await upsertCredential(
        {
          tenant_id: tenantId,
          connector_id: connectorId,
          environment: "dev",
          mode: "oauth2",
          value: {
            mode: "oauth2",
            access_token: bundle.access_token,
            token_type: bundle.token_type,
          },
          oauth2_refresh_token: bundle.refresh_token,
          oauth2_expires_at: bundle.expires_at,
          actor_id: null,
        },
        ctx.db,
      );

      const rows = await ctx.db
        .select()
        .from(connectors)
        .where(eq(connectors.id, connectorId))
        .limit(1);
      const connector = rows[0]!;
      const res = await gqlQuery({
        db: ctx.db,
        tenant_id: tenantId,
        // biome-ignore lint/suspicious/noExplicitAny: drizzle row → ConnectorView shape match
        connector: connector as any,
        query: "{ __schema { queryType { name fields { name } } } }",
      });
      if (res.status === 501) throw new Error("subscription path triggered unexpectedly");
      expect(res.status).toBe(200);
      expect(res.auth_method).toBe("oauth2_static");
      const body = res.body as {
        data?: { __schema?: { queryType?: { fields: Array<{ name: string }> } } };
      };
      const fields = body.data?.__schema?.queryType?.fields ?? [];
      expect(fields.length).toBeGreaterThan(0);
    },
  );

  liveTest("REFRESH_TOKEN_AUTH yields a fresh IdToken with the same refresh_token", async () => {
    const first = await runCognitoUserPasswordGrant({
      region: REGION,
      client_id: CLIENT_ID,
      username: EMAIL,
      password: PASSWORD,
    });
    const { runCognitoRefreshTokenGrant } = await import(
      "../../apps/engine/src/credentials/oauth2/client.ts"
    );
    const refreshed = await runCognitoRefreshTokenGrant({
      region: REGION,
      client_id: CLIENT_ID,
      username: EMAIL,
      password: "",
      refresh_token: first.refresh_token!,
    });
    expect(refreshed.access_token.startsWith("eyJ")).toBe(true);
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect(refreshed.refresh_token).toBe(first.refresh_token);
    expect(refreshed.token_type).toBe("none");
  });
});
