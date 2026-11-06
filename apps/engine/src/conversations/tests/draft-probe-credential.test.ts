import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryService from "../../connectors/discovery/service.ts";
import { createConnector, getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector, upsertCredential } from "../../credentials/service.ts";
import { conversations as conversationsTable, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { __setMcpPoolFactoriesForTests, type McpClientLike } from "../../mcp/client/pool.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { startLocalTargetServer } from "../../test-helpers/local-http.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state/index.ts";
import { hydrateDraftFromSavedConnector } from "../authoring-state/normalize.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import {
  _resetDraftCredentialCacheForTests,
  getDraftCredential,
  setDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import type { ToolContext } from "../tools/index.ts";
import { probeConnectorDraftTool } from "../tools/probe-connector-draft.ts";
import { updateConnectorDraftTool } from "../tools/update-connector-draft.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("draft_probe_credential");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-dpc", display_name: "T-DPC" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(() => {
  __setMcpPoolFactoriesForTests(null);
  _resetDraftCredentialCacheForTests();
});

function buildBearerDraft(baseUrl: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: "do-test",
      slug: "do-test",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: baseUrl,
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
  return withConnectorProbe(validated, { ...validated.connector }, true, "ready to probe");
}

async function seedConversation(): Promise<string> {
  const [row] = await ctx.db
    .insert(conversationsTable)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  return row!.id;
}

async function buildToolCtx(conversation_id: string, draft: DraftDocument): Promise<ToolContext> {
  await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);
  let liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => liveDraft,
    setDraft: async (next) => {
      await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
      liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
    },
  };
}

describe("probe_connector_draft + draft credential", () => {
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

  test("sends Authorization: Bearer <token> when cache populated", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = await startLocalTargetServer((req) => {
      captured.auth = req.headers.get("authorization");
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);

      setDraftCredential(conversation_id, { mode: "bearer", token: "DO-TEST-TOKEN" });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.auth).toBe("Bearer DO-TEST-TOKEN");
    } finally {
      await server.stop();
    }
  });

  test("MCP bearer probe handshakes transiently, then atomically saves connector and credential", async () => {
    let capturedHeaders: Record<string, string> = {};
    let closeCount = 0;
    const fakeClient: McpClientLike = {
      async connect() {},
      async listTools() {
        return {
          tools: [
            {
              name: "content_list",
              description: "List editorial content",
              inputSchema: { type: "object" },
            },
          ],
        };
      },
      async callTool() {
        return { content: [], isError: false };
      },
      async readResource() {
        return { contents: [] };
      },
      async getPrompt() {
        return { messages: [] };
      },
      async close() {
        closeCount += 1;
      },
    };
    __setMcpPoolFactoriesForTests({
      makeClient: () => fakeClient,
      makeTransport: (_row, headers) => {
        capturedHeaders = headers;
        return {} as never;
      },
    });

    const conversation_id = await seedConversation();
    const draft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "ContentKit Editorial MCP PROD",
        slug: "contentkit-editorial-mcp-prod-test",
        driver: "mcp",
        environment: "prod",
        auth_type: "bearer",
        base_url: "https://contentkit-editorial.mcpprobetest.invalid/mcp",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      },
      workflow: { name: "", steps: [] },
    };
    const validated = withConnectorValidation(
      withConnectorInspection(draft),
      {
        ...draft.connector,
        validation: validateConnectorDraft(draft.connector ?? null, []),
      },
      true,
      "validated",
    );
    const toolCtx = await buildToolCtx(conversation_id, validated);
    setDraftCredential(conversation_id, { mode: "bearer", token: "EDITORIAL-TEST-TOKEN" });

    const result = await probeConnectorDraftTool.execute(toolCtx, {});
    expect(result.ok).toBe(true);
    expect(capturedHeaders.Authorization).toBe("Bearer EDITORIAL-TEST-TOKEN");
    expect(closeCount).toBe(1);
    expect(getDraftCredential(conversation_id)).toBeNull();

    const data = result.data as {
      auto_saved?: boolean;
      connector?: { id?: string };
      latest_probe?: { method?: string };
    };
    expect(data.auto_saved).toBe(true);
    expect(data.latest_probe?.method).toBe("MCP initialize + tools/list");
    const connectorId = data.connector?.id;
    expect(connectorId).toBeString();
    if (!connectorId) throw new Error("auto-save did not return connector id");

    const saved = await getConnector(tenant_id, connectorId, ctx.db);
    expect(saved).toMatchObject({
      driver: "mcp",
      environment: "prod",
      auth_type: "bearer",
      config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
    });
    const credential = await getCredentialForConnector(tenant_id, connectorId, "prod", ctx.db);
    expect(credential?.value).toEqual({ mode: "bearer", token: "EDITORIAL-TEST-TOKEN" });
  });

  test("returns credential_required when cache is empty for auth-required draft", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach upstream", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("credential_required");
      expect(data.recommended_next).toContain("ask_user_form");
    } finally {
      await server.stop();
    }
  });

  test("returns authenticate_oauth_required envelope for an oauth2 BYO cache hit (no HTTP request)", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach upstream", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const gmailDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "Gmail API",
          slug: "gmail-api",
          driver: "http",
          environment: "dev",
          auth_type: "oauth2",
          base_url: server.url,
          config: { oauth: { grant_type: "authorization_code" } },
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gmailDraft),
        {
          ...gmailDraft.connector,
          validation: validateConnectorDraft(gmailDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);

      setDraftCredential(conversation_id, {
        mode: "oauth2",
        client_id: "client-abc",
        client_secret: "secret-xyz",
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/users/me/profile",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("authenticate_oauth_required");
      expect(data.recommended_next).toContain("authenticate_oauth");
    } finally {
      await server.stop();
    }
  });

  test("auth_type=none drafts probe without a credential", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = await startLocalTargetServer((req) => {
      captured.auth = req.headers.get("authorization");
      return new Response("ok", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const draft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "open",
          slug: "open",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(draft),
        {
          ...draft.connector,
          validation: validateConnectorDraft(draft.connector ?? null, []),
        },
        true,
        "ok",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.auth).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test("graphql driver with bearer cache hit — introspection reaches the endpoint", async () => {
    const captured: { body: string | null; auth: string | null } = { body: null, auth: null };
    const server = await startLocalTargetServer(async (req) => {
      if (req.method === "POST" && captured.body === null) {
        captured.auth = req.headers.get("authorization");
        const text = await req.text();
        captured.body = text;
      }
      return new Response(JSON.stringify({ data: { __typename: "Query" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-bearer",
          slug: "gql-bearer",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, { mode: "bearer", token: "gql-test-token" });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.body).toContain("__typename");
      expect(captured.auth).toBe("Bearer gql-test-token");
    } finally {
      await server.stop();
    }
  });

  test("graphql driver without cached credential — credential_required, server never hit", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-no-cred",
          slug: "gql-no-cred",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("credential_required");
      expect(data.recommended_next).toContain("ask_user_form");
    } finally {
      await server.stop();
    }
  });

  test("graphql driver with cognito_user_password cache hit — minted JWT reaches endpoint as raw token", async () => {
    const capturedAuth: { value: string | null } = { value: null };

    const gqlServer = await startLocalTargetServer(async (req) => {
      if (req.method === "POST" && capturedAuth.value === null) {
        capturedAuth.value = req.headers.get("authorization");
      }
      return new Response(JSON.stringify({ data: { __typename: "Query" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("cognito-idp")) {
        return new Response(
          JSON.stringify({
            AuthenticationResult: {
              IdToken: "minted-id-token-jwt",
              ExpiresIn: 3600,
            },
          }),
          { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } },
        );
      }
      return realFetch(url, init);
    }) as typeof fetch;

    try {
      await withSelfHostedDriverFetchForTests(fetchImpl, async () => {
        const conversation_id = await seedConversation();
        const cognitoDraft: DraftDocument = {
          mode: "connector_authoring",
          connector: {
            name: "appsync-cognito",
            slug: "appsync-cognito",
            driver: "graphql",
            environment: "dev",
            auth_type: "oauth2",
            base_url: gqlServer.url,
            config: {
              aws_region: "eu-central-1",
              oauth: { client_id: "client-abc", grant_type: "cognito_user_password" },
            },
          },
          workflow: { name: "", steps: [] },
        };
        const validated = withConnectorValidation(
          withConnectorInspection(cognitoDraft),
          {
            ...cognitoDraft.connector,
            validation: validateConnectorDraft(cognitoDraft.connector ?? null, []),
          },
          true,
          "validated",
        );
        const toolCtx = await buildToolCtx(conversation_id, validated);
        setDraftCredential(conversation_id, {
          mode: "cognito_user_password",
          username: "user@example.com",
          password: "hunter2",
          aws_region: "eu-central-1",
          client_id: "client-abc",
        });

        const result = await probeConnectorDraftTool.execute(toolCtx, {
          method: "POST",
          path: "/graphql",
          timeout_ms: 5_000,
        });

        expect(result.ok).toBe(true);
        expect(capturedAuth.value).toBe("minted-id-token-jwt");
      });
    } finally {
      await gqlServer.stop();
    }
  });

  test("graphql probe with explicit path arg still runs introspection (body contains __typename)", async () => {
    const captured: { body: string | null } = { body: null };
    const server = await startLocalTargetServer(async (req) => {
      if (req.method === "POST" && captured.body === null) {
        const text = await req.text();
        captured.body = text;
      }
      return new Response(JSON.stringify({ data: { __typename: "Query" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-explicit-path",
          slug: "gql-explicit-path",
          driver: "graphql",
          environment: "dev",
          auth_type: "none",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.body).not.toBe("");
      expect(captured.body).not.toBeNull();
      const parsed = JSON.parse(captured.body!) as { query?: string };
      expect(parsed.query).toContain("__typename");
    } finally {
      await server.stop();
    }
  });

  test("graphql driver with oauth2 seed cached returns authenticate_oauth_required, server never hit", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const gmailGraphqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-oauth2-byo",
          slug: "gql-oauth2-byo",
          driver: "graphql",
          environment: "dev",
          auth_type: "oauth2",
          base_url: server.url,
          config: { oauth: { grant_type: "authorization_code" } },
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gmailGraphqlDraft),
        {
          ...gmailGraphqlDraft.connector,
          validation: validateConnectorDraft(gmailGraphqlDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, {
        mode: "oauth2",
        client_id: "client-abc",
        client_secret: "secret-xyz",
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("authenticate_oauth_required");
      expect(data.recommended_next).toContain("authenticate_oauth");
    } finally {
      await server.stop();
    }
  });

  test("cached bearer credential on a basic draft → credential_mode_mismatch, cache cleared, server never hit", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach upstream", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const basicDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "basic-after-flip",
          slug: "basic-after-flip",
          driver: "http",
          environment: "dev",
          auth_type: "basic",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(basicDraft),
        {
          ...basicDraft.connector,
          validation: validateConnectorDraft(basicDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, { mode: "bearer", token: "stale-bearer-token" });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("credential_mode_mismatch");
      expect(data.recommended_next).toContain("ask_user_form");
      expect(getDraftCredential(conversation_id)).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test("re-probing an unchanged failed draft returns probe_unchanged without hitting the network", async () => {
    let hits = 0;
    const server = await startLocalTargetServer(() => {
      hits += 1;
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);
      setDraftCredential(conversation_id, { mode: "bearer", token: "same-token" });

      const first = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(first.ok).toBe(false);
      expect(hits).toBe(1);

      const second = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(second.ok).toBe(false);
      expect(hits).toBe(1);
      const data = second.data as {
        error_code?: string;
        latest_probe?: { ok?: boolean; status_code?: number } | null;
        recommended_next?: string[];
      };
      expect(data.error_code).toBe("probe_unchanged");
      expect(data.latest_probe?.ok).toBe(false);
      expect(data.latest_probe?.status_code).toBe(403);
      expect(data.recommended_next).toContain("fetch_connector_docs");

      const third = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/other",
        timeout_ms: 5_000,
      });
      expect(third.ok).toBe(false);
      expect(hits).toBe(2);
    } finally {
      await server.stop();
    }
  });

  test("graphql re-probe with jittered args is still refused as probe_unchanged", async () => {
    let hits = 0;
    const server = await startLocalTargetServer(() => {
      hits += 1;
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-jitter",
          slug: "gql-jitter",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, { mode: "bearer", token: "gql-jitter-token" });

      const first = await probeConnectorDraftTool.execute(toolCtx, {
        method: "POST",
        path: "/",
        timeout_ms: 5_000,
      });
      expect(first.ok).toBe(false);
      expect(hits).toBe(1);

      const second = await probeConnectorDraftTool.execute(toolCtx, {
        method: "POST",
        path: "/graphql",
        headers: { "x-debug": "1" },
        timeout_ms: 5_000,
      });
      expect(second.ok).toBe(false);
      expect(hits).toBe(1);
      expect((second.data as { error_code?: string }).error_code).toBe("probe_unchanged");
    } finally {
      await server.stop();
    }
  });

  test("a transient 503 prior failure skips the probe_unchanged guard", async () => {
    let hits = 0;
    const server = await startLocalTargetServer(() => {
      hits += 1;
      return new Response("upstream hiccup", { status: 503 });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);
      setDraftCredential(conversation_id, { mode: "bearer", token: "same-token" });

      const first = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(first.ok).toBe(false);
      expect(hits).toBe(1);

      const second = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(second.ok).toBe(false);
      expect(hits).toBe(2);
      const data = second.data as { error_code?: string };
      expect(data.error_code).not.toBe("probe_unchanged");
    } finally {
      await server.stop();
    }
  });

  test("auth_type flip via update_connector_draft clears the cached credential", async () => {
    const conversation_id = await seedConversation();
    const draft = buildBearerDraft("https://api.example.test");
    const toolCtx = await buildToolCtx(conversation_id, draft);
    setDraftCredential(conversation_id, { mode: "bearer", token: "soon-stale" });

    const result = await updateConnectorDraftTool.execute(toolCtx, { auth_type: "basic" });

    expect(result.ok).toBe(true);
    expect(getDraftCredential(conversation_id)).toBeNull();
    const data = result.data as { credential_cache_cleared?: boolean };
    expect(data.credential_cache_cleared).toBe(true);
  });

  test("reuses the saved connector's stored credential when the draft is already persisted (empty cache)", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = await startLocalTargetServer((req) => {
      captured.auth = req.headers.get("authorization");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const saved = await createConnector(
        {
          tenant_id,
          input: {
            name: "saved-bearer",
            driver: "http",
            environment: "dev",
            auth_type: "bearer",
            base_url: server.url,
          },
          actor_id: null,
        },
        ctx.db,
      );
      await upsertCredential(
        {
          tenant_id,
          connector_id: saved.id,
          environment: "dev",
          mode: "bearer",
          value: { mode: "bearer", token: "VAULT-TOKEN" },
          actor_id: null,
        },
        ctx.db,
      );

      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const boundDraft: DraftDocument = {
        ...draft,
        connector: { ...draft.connector!, saved_connector_id: saved.id },
      };
      const toolCtx = await buildToolCtx(conversation_id, boundDraft);
      expect(getDraftCredential(conversation_id)).toBeNull();

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.auth).toBe("Bearer VAULT-TOKEN");
    } finally {
      await server.stop();
    }
  });

  test("a draft hydrated from a saved connector holds the mask, and the probe still sends the stored secret", async () => {
    const HEADER_SECRET = "fixture-header-secret-not-real";
    const captured: { key: string | null } = { key: null };
    const server = await startLocalTargetServer((req) => {
      captured.key = req.headers.get("x-api-key");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const saved = await createConnector(
        {
          tenant_id,
          input: {
            name: "saved-static-header",
            driver: "http",
            environment: "dev",
            auth_type: "bearer",
            base_url: server.url,
            config: { static_headers: { "X-Api-Key": HEADER_SECRET } },
          },
          actor_id: null,
        },
        ctx.db,
      );
      await upsertCredential(
        {
          tenant_id,
          connector_id: saved.id,
          environment: "dev",
          mode: "bearer",
          value: { mode: "bearer", token: "VAULT-TOKEN" },
          actor_id: null,
        },
        ctx.db,
      );

      const hydrated = hydrateDraftFromSavedConnector(saved);
      expect(JSON.stringify(hydrated)).not.toContain(HEADER_SECRET);

      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, {
        ...draft,
        connector: { ...draft.connector, ...hydrated },
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.key).toBe(HEADER_SECRET);
      expect(JSON.stringify(result)).not.toContain(HEADER_SECRET);
    } finally {
      await server.stop();
    }
  });
});
