import { describe, expect, test } from "bun:test";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import { __setMcpPoolFactoriesForTests, type McpClientLike } from "../../mcp/client/pool.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { startLocalTargetServer } from "../../test-helpers/local-http.ts";
import { withConnectorInspection, withConnectorValidation } from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { getDraftCredential, setDraftCredential } from "../persistence/draft-credential-cache.ts";
import { probeConnectorDraftTool } from "../tools/probe-connector-draft.ts";
import type { DraftDocument } from "../types.ts";
import {
  buildBearerDraft,
  buildToolCtx,
  ctx,
  seedConversation,
  tenant_id,
  useDraftProbeCredentialDescribeSetup,
  useDraftProbeCredentialSetup,
} from "./draft-probe-credential-fixtures.ts";

useDraftProbeCredentialSetup();

describe("probe_connector_draft + draft credential", () => {
  useDraftProbeCredentialDescribeSetup();

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
});
