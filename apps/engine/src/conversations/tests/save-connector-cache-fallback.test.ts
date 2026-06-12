// Cache-fallback test for saveConnectorAtomic.
//
// Bug 2026-04-27: when the LLM retries `save_connector_draft` after the
// auto-persist's first attempt failed (e.g. probe gate), it cannot
// inline a credential because the secret only ever flows through the
// masked form into the in-memory cache. saveConnectorAtomic must read
// from `getDraftCredential` as a fallback so the operator does not get
// bounced through `ask_user_form` a second time. The contract this
// test pins:
//   - call saveConnectorAtomic with NO inline credential, after
//     populating the draft credential cache, on a draft whose
//     latest_probe is green and auth_type matches the cached mode.
//   - the connector + credential rows are persisted exactly once.
//   - no `credential_required` envelope is returned.
// Bypassing the fallback re-opens the duplicate-token-input bug.

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as discoveryService from "../../connectors/discovery/service.ts";
import { connectors, conversations, credentials, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import {
  _resetDraftCredentialCacheForTests,
  setDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import { saveConnectorAtomic } from "../persistence/save-connector.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("save_connector_cache_fallback");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-cache", display_name: "T-CACHE" })
    .returning();
  tenant_id = t!.id;
});

beforeEach(() => {
  _resetDraftCredentialCacheForTests();
});

afterAll(async () => {
  await ctx.cleanup();
});

function readyDraft(slug: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: slug,
      slug,
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.example.test",
    },
    workflow: { name: "", steps: [] },
  };
  const validated = withConnectorValidation(
    withConnectorInspection(baseDraft),
    {
      ...baseDraft.connector,
      validation: validateConnectorDraft(baseDraft.connector ?? null),
    },
    true,
    "Connector draft validated.",
  );
  return withConnectorProbe(
    validated,
    {
      ...validated.connector,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/health",
        environment: "dev",
        status_code: 200,
        summary: "ok",
      },
    },
    true,
    "ok",
  );
}

async function seed(slug: string): Promise<{ conversation_id: string; tool_ctx: ToolContext }> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  const conversation_id = conv!.id;
  const draft = readyDraft(slug);
  await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);
  let live = draft;
  const tool_ctx: ToolContext = {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    engineClient: {} as never,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
      await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
    },
  };
  return { conversation_id, tool_ctx };
}

describe("saveConnectorAtomic — draft-credential cache fallback", () => {
  test("persists when no inline credential is supplied but the cache has a matching mode", async () => {
    const { conversation_id, tool_ctx } = await seed("cache-fallback-bearer");
    setDraftCredential(conversation_id, { mode: "bearer", token: "secret-from-form" });

    const result = await saveConnectorAtomic({
      ctx: tool_ctx,
      environment: "dev",
      reason: "manual_re_issue",
      // No `credential` — simulates the LLM-issued retry path.
    });

    expect(result.ok).toBe(true);

    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(
        and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "cache-fallback-bearer")),
      );
    expect(conn).toHaveLength(1);
    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(1);
    expect(cred[0]!.mode).toBe("bearer");

    // The save-side cache clear ran; subsequent reads return null so a
    // future probe goes through `getCredentialForConnector`.
    const draftAfter = await loadDraft(tenant_id, conversation_id, ctx.db);
    expect(draftAfter.connector?.saved_connector_id).toBe(conn[0]!.id);
  });

  test("returns credential_required when neither inline credential nor cache is set", async () => {
    const { tool_ctx } = await seed("cache-fallback-none");
    // Cache cleared in beforeEach; no inline credential.
    const result = await saveConnectorAtomic({
      ctx: tool_ctx,
      environment: "dev",
      reason: "manual_re_issue",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("credential_required");
  });

  test("ignores cached credential whose mode does not match the connector auth_type", async () => {
    const { conversation_id, tool_ctx } = await seed("cache-fallback-mismatch");
    // Connector wants bearer; cache has basic. Must NOT use it.
    setDraftCredential(conversation_id, {
      mode: "basic",
      username: "u",
      password: "p",
    });
    const result = await saveConnectorAtomic({
      ctx: tool_ctx,
      environment: "dev",
      reason: "manual_re_issue",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("credential_required");
  });
});

// RC-3: credentialModeMatchesAuthType — cognito_user_password cached credential
// satisfies the credential gate on an oauth2 auth_type graphql connector.
describe("saveConnectorAtomic — cognito_user_password cache fallback for oauth2 graphql connector", () => {
  // Stub post-save auto-discovery so the graphql connector save never
  // launches a real browser (playwright-crawl) or makes live network calls.
  // The fire-and-forget `void runDiscoveryCached(...)` in saveConnectorAtomic
  // would otherwise become an unhandled rejection that bun test attributes to
  // whichever test is in-flight when the browser spawn fails.
  let discoverySpy: ReturnType<typeof spyOn<typeof discoveryService, "runDiscoveryCached">>;
  beforeAll(() => {
    discoverySpy = spyOn(discoveryService, "runDiscoveryCached").mockResolvedValue({
      source: "fresh",
      cache_key: "url:stub",
      result: {
        source_url: "",
        // Fixed timestamp — value is never asserted; a literal keeps the
        // determinism lint happy (no `new Date()` in *.test.ts).
        fetched_at: "2023-11-14T22:13:20.000Z",
        strategy: "graphql-introspect",
        spec_version: null,
        title: null,
        servers: [],
        auth_schemes: [],
        endpoints: [],
        warnings: [],
      },
    });
  });
  afterAll(() => {
    discoverySpy.mockRestore();
  });

  function readyGraphqlOAuth2Draft(slug: string): DraftDocument {
    const baseDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: slug,
        slug,
        driver: "graphql",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
        config: {
          aws_region: "eu-central-1",
          oauth: { client_id: "client-abc", grant_type: "cognito_user_password" },
        },
      },
      workflow: { name: "", steps: [] },
    };
    const validated = withConnectorValidation(
      withConnectorInspection(baseDraft),
      {
        ...baseDraft.connector,
        validation: validateConnectorDraft(baseDraft.connector ?? null),
      },
      true,
      "Connector draft validated.",
    );
    // OAuth2 connectors skip the probe gate on first save, so we do NOT
    // add a latest_probe — the save must proceed with validation only.
    return validated;
  }

  async function seedGraphql(
    slug: string,
  ): Promise<{ conversation_id: string; tool_ctx: ToolContext }> {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const draft = readyGraphqlOAuth2Draft(slug);
    await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);
    let live = draft;
    const tool_ctx: ToolContext = {
      db: ctx.db,
      tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
      engineClient: {} as never,
      getDraft: () => live,
      setDraft: async (next) => {
        live = next;
        await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
      },
    };
    return { conversation_id, tool_ctx };
  }

  // Stub runCognitoUserPasswordGrant via the driver-fetch seam so no real
  // Cognito endpoint is called. The grant fires inside persistCredential
  // when the credential mode is "cognito_user_password".
  test("cognito_user_password cache hit on oauth2 connector — connector + credential row persisted", async () => {
    // Cast to `typeof fetch` via the async closure — covers only url+init.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("cognito-idp")) {
        return new Response(
          JSON.stringify({
            AuthenticationResult: {
              IdToken: "minted-jwt",
              ExpiresIn: 3600,
            },
          }),
          { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } },
        );
      }
      // Non-Cognito calls are unexpected in this test — let them fail loudly.
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await withDriverFetchForTests(fetchImpl, async () => {
      const { conversation_id, tool_ctx } = await seedGraphql("cognito-oauth2-graphql");
      setDraftCredential(conversation_id, {
        mode: "cognito_user_password",
        username: "user@example.com",
        password: "hunter2",
        aws_region: "eu-central-1",
        client_id: "client-abc",
      });

      const result = await saveConnectorAtomic({
        ctx: tool_ctx,
        environment: "dev",
        reason: "manual_re_issue",
        forceSave: true,
      });

      expect(result.ok).toBe(true);

      const conn = await ctx.db
        .select()
        .from(connectors)
        .where(
          and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "cognito-oauth2-graphql")),
        );
      expect(conn).toHaveLength(1);
      // cognito_user_password exchanges for an oauth2 token; the persisted
      // credential mode is "oauth2".
      const cred = await ctx.db
        .select()
        .from(credentials)
        .where(
          and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)),
        );
      expect(cred).toHaveLength(1);
      expect(cred[0]!.mode).toBe("oauth2");
    });
  });

  // RC-3 negative: a `basic` cached credential must NOT satisfy the gate for an
  // `oauth2` connector. credentialModeMatchesAuthType must not over-accept.
  test("basic cached credential on oauth2 connector — still returns credential_required", async () => {
    const { conversation_id, tool_ctx } = await seedGraphql("cognito-oauth2-graphql-negative");
    setDraftCredential(conversation_id, {
      mode: "basic",
      username: "u",
      password: "p",
    });

    const result = await saveConnectorAtomic({
      ctx: tool_ctx,
      environment: "dev",
      reason: "manual_re_issue",
      forceSave: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("credential_required");
  });
});
