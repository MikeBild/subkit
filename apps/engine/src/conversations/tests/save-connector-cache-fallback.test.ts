import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as discoveryService from "../../connectors/discovery/service.ts";
import { auditLog, connectors, conversations, credentials } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state/index.ts";
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
  tenant_id = (await seedTenant(ctx.db, { slug: "t-cache", display_name: "T-CACHE" })).id;
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
      validation: validateConnectorDraft(baseDraft.connector ?? null, []),
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
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
      await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
    },
  };
  return { conversation_id, tool_ctx };
}

describe("saveConnectorAtomic — draft-credential cache fallback", () => {
  test("does not save a static-auth MCP draft before a green handshake", async () => {
    const { conversation_id, tool_ctx } = await seed("mcp-probe-required-seed");
    const baseDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "mcp-probe-required",
        slug: "mcp-probe-required",
        driver: "mcp",
        environment: "prod",
        auth_type: "bearer",
        base_url: "https://mcp-probe-required.example.test/mcp",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      },
      workflow: { name: "", steps: [] },
    };
    const validated = withConnectorValidation(
      withConnectorInspection(baseDraft),
      {
        ...baseDraft.connector,
        validation: validateConnectorDraft(baseDraft.connector ?? null, []),
      },
      true,
      "validated",
    );
    await tool_ctx.setDraft(validated);
    setDraftCredential(conversation_id, { mode: "bearer", token: "not-yet-probed" });

    const result = await saveConnectorAtomic({
      ctx: tool_ctx,
      environment: "prod",
      reason: "manual_re_issue",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("connector_not_ready");
      expect(result.next_best_actions).toContain("probe_connector_draft");
    }
  });

  test("persists when no inline credential is supplied but the cache has a matching mode", async () => {
    const { conversation_id, tool_ctx } = await seed("cache-fallback-bearer");
    setDraftCredential(conversation_id, { mode: "bearer", token: "secret-from-form" });

    const result = await saveConnectorAtomic({
      ctx: tool_ctx,
      environment: "dev",
      reason: "manual_re_issue",
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

    const draftAfter = await loadDraft(tenant_id, conversation_id, ctx.db);
    expect(draftAfter.connector?.saved_connector_id).toBe(conn[0]!.id);
  });

  test("returns credential_required when neither inline credential nor cache is set", async () => {
    const { tool_ctx } = await seed("cache-fallback-none");
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

describe("saveConnectorAtomic — cognito_user_password cache fallback for oauth2 graphql connector", () => {
  let discoverySpy: ReturnType<typeof spyOn<typeof discoveryService, "runDiscoveryCached">>;
  beforeAll(() => {
    discoverySpy = spyOn(discoveryService, "runDiscoveryCached").mockResolvedValue({
      source: "fresh",
      cache_key: "url:stub",
      result: {
        source_url: "",
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
        validation: validateConnectorDraft(baseDraft.connector ?? null, []),
      },
      true,
      "Connector draft validated.",
    );
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
      engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
      getDraft: () => live,
      setDraft: async (next) => {
        live = next;
        await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
      },
    };
    return { conversation_id, tool_ctx };
  }

  test("cognito_user_password cache hit on oauth2 connector — connector + credential row persisted", async () => {
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
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await withSelfHostedDriverFetchForTests(fetchImpl, async () => {
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
      const cred = await ctx.db
        .select()
        .from(credentials)
        .where(
          and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)),
        );
      expect(cred).toHaveLength(1);
      expect(cred[0]!.mode).toBe("oauth2");
      await waitFor(() => tenantWorkSnapshot(tenant_id).in_flight === 0, {
        tries: 5000,
        sleepMs: 2,
        label: "connector discovery audit",
      });
      const discoveryReceipts = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenant_id),
            eq(auditLog.resource_id, conn[0]!.id),
            eq(auditLog.action, "connector.discovered"),
          ),
        );
      expect(discoveryReceipts).toHaveLength(1);
    });
  });

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
