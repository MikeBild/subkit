import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { auth as authorize } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import { getOAuth2ClientCredential } from "../../credentials/service.ts";
import { connectors, conversations } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { makeMcpOAuthProvider } from "../../mcp/index.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { withConnectorInspection, withConnectorValidation } from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot } from "../draft.ts";
import {
  _resetDraftCredentialCacheForTests,
  setDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import { preRegisteredClientNeedsIssuer, withMcpIssuer } from "../persistence/mcp-client-issuer.ts";
import { saveConnectorAtomic } from "../persistence/save-connector.ts";
import type { ToolContext } from "../tools/index.ts";
import type { ConnectorDraftDocument, DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;
const issuer = "https://auth.issuer.example.test";

beforeAll(async () => {
  ctx = await createTestDb("save_mcp_client_issuer");
  tenant_id = (await seedTenant(ctx.db, { slug: "t-mcp-issuer", display_name: "MCP" })).id;
});

beforeEach(() => {
  _resetDraftCredentialCacheForTests();
});

afterAll(async () => {
  await ctx.cleanup();
});

function authorizationServer(serverUrl: string) {
  const registrations: unknown[] = [];
  const fetchFn = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(target instanceof Request ? target.url : target);
    if (url.includes("oauth-protected-resource"))
      return Response.json({ resource: serverUrl, authorization_servers: [issuer] });
    if (url.includes("oauth-authorization-server") || url.includes("openid-configuration"))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    if (url === `${issuer}/register`) {
      registrations.push(JSON.parse(String(init?.body)));
      return Response.json({ client_id: "unexpected", redirect_uris: [] }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { registrations, fetchFn };
}

const unreachable = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;

function draftFor(slug: string, auth: Record<string, unknown>): DraftDocument {
  const connector: ConnectorDraftDocument = {
    name: slug,
    slug,
    driver: "mcp",
    environment: "prod",
    auth_type: "oauth2",
    base_url: `https://${slug}.example.test/mcp`,
    config: { mcp: { transport: "http", auth } },
  };
  const base: DraftDocument = {
    mode: "connector_authoring",
    connector,
    workflow: { name: "", steps: [] },
  };
  return withConnectorValidation(
    withConnectorInspection(base),
    { ...connector, validation: validateConnectorDraft(connector, []) },
    true,
    "validated",
  );
}

async function seed(draft: DraftDocument): Promise<{ conversation_id: string; tool: ToolContext }> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  const conversation_id = conv!.id;
  await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);
  let live = draft;
  return {
    conversation_id,
    tool: {
      db: ctx.db,
      tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
      getDraft: () => live,
      setDraft: async (next) => {
        live = next;
        await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
      },
    },
  };
}

async function savedRow(slug: string) {
  const [row] = await ctx.db
    .select()
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, slug)));
  return row;
}

describe("preRegisteredClientNeedsIssuer", () => {
  const cases: ReadonlyArray<[string, Record<string, unknown>, boolean, boolean]> = [
    ["dynamic registration", { kind: "oauth2" }, false, false],
    ["configured client without issuer", { kind: "oauth2", client_id: "c" }, false, true],
    ["configured client with issuer", { kind: "oauth2", client_id: "c", issuer }, false, false],
    ["form client without issuer", { kind: "oauth2" }, true, true],
    ["form client with issuer", { kind: "oauth2", issuer }, true, false],
  ];
  for (const [name, auth, fromForm, expected] of cases) {
    test(name, () => {
      expect(
        preRegisteredClientNeedsIssuer(
          { mcp: { auth } },
          fromForm ? { mode: "oauth2", client_id: "c" } : undefined,
        ),
      ).toBe(expected);
    });
  }
  test("withMcpIssuer binds the issuer in config.mcp.auth", () => {
    expect(withMcpIssuer({ mcp: { transport: "http", auth: { kind: "oauth2" } } }, issuer)).toEqual(
      { mcp: { transport: "http", auth: { kind: "oauth2", issuer } } },
    );
  });
});

describe("saveConnectorAtomic — pre-registered MCP client without issuer", () => {
  test("a configured public client gets the discovered issuer and signs in without registering", async () => {
    const { tool } = await seed(
      draftFor("mcp-public-discover", { kind: "oauth2", client_id: "public-1" }),
    );
    const server = authorizationServer("https://mcp-public-discover.example.test/mcp");

    const result = await withSelfHostedDriverFetchForTests(server.fetchFn, () =>
      saveConnectorAtomic({ ctx: tool, environment: "prod" }),
    );

    expect(result.ok).toBe(true);
    const row = await savedRow("mcp-public-discover");
    const auth =
      (row?.config as { mcp: { auth: Record<string, string> } } | undefined)?.mcp.auth ?? {};
    expect(new URL(auth.issuer ?? "").origin).toBe(issuer);
    expect(auth.client_id).toBe("public-1");

    const provider = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id,
      connector_id: row!.id,
      environment: "prod",
      redirect_uri: "https://engine.example.test/v1/connectors/mcp/oauth/callback",
      state: "issuer-state",
      auth: { kind: "oauth2", client_id: "public-1", issuer: auth.issuer ?? issuer },
      interactive: true,
      request_source: "api",
    });
    expect(
      await authorize(provider, {
        serverUrl: "https://mcp-public-discover.example.test/mcp",
        fetchFn: server.fetchFn,
      }),
    ).toBe("REDIRECT");
    expect(server.registrations).toHaveLength(0);
  });

  test("a client secret from the form is bound to the discovered issuer", async () => {
    const { conversation_id, tool } = await seed(
      draftFor("mcp-secret-discover", { kind: "oauth2" }),
    );
    setDraftCredential(conversation_id, {
      mode: "oauth2",
      client_id: "confidential-1",
      client_secret: "pre-registered-secret",
    });
    const server = authorizationServer("https://mcp-secret-discover.example.test/mcp");

    const result = await withSelfHostedDriverFetchForTests(server.fetchFn, () =>
      saveConnectorAtomic({ ctx: tool, environment: "prod" }),
    );

    expect(result.ok).toBe(true);
    const row = await savedRow("mcp-secret-discover");
    const stored = await getOAuth2ClientCredential(tenant_id, row!.id, "prod", ctx.db);
    expect(stored?.client_id).toBe("confidential-1");
    expect(new URL(stored?.issuer ?? "").origin).toBe(issuer);
  });

  test("a failed discovery refuses the save and stores nothing", async () => {
    const { tool } = await seed(
      draftFor("mcp-issuer-down", { kind: "oauth2", client_id: "public-2" }),
    );

    const result = await withSelfHostedDriverFetchForTests(unreachable, () =>
      saveConnectorAtomic({ ctx: tool, environment: "prod" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("mcp_oauth_issuer_unresolved");
      expect(result.message).toContain("config.mcp.auth.issuer");
    }
    expect(await savedRow("mcp-issuer-down")).toBeUndefined();
  });
});
