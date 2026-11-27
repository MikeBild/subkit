import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, conversations, vaultItems } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot } from "../draft.ts";
import {
  _resetDraftCredentialCacheForTests,
  setDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import { saveConnectorAtomic } from "../persistence/save-connector.ts";
import type { ToolContext } from "../tools/index.ts";
import type { ConnectorDraftDocument, DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("save_mcp_sign_in");
  tenant_id = (await seedTenant(ctx.db, { slug: "t-mcp-sign-in", display_name: "MCP" })).id;
});

beforeEach(() => {
  _resetDraftCredentialCacheForTests();
});

afterAll(async () => {
  await ctx.cleanup();
});

function signInDraft(connector: ConnectorDraftDocument): DraftDocument {
  const base: DraftDocument = {
    mode: "connector_authoring",
    connector,
    workflow: { name: "", steps: [] },
  };
  const validated = withConnectorValidation(
    withConnectorInspection(base),
    { ...connector, validation: validateConnectorDraft(connector, []) },
    true,
    "validated",
  );
  return withConnectorProbe(
    validated,
    {
      ...validated.connector,
      latest_probe: {
        ok: false,
        method: "POST",
        path: "/mcp",
        environment: "prod",
        status_code: 401,
        summary: "unauthorized",
        failure_code: "auth_rejected",
      },
    },
    false,
    "401 before sign-in",
  );
}

function mcpOAuthConnector(
  slug: string,
  auth: Record<string, unknown> = { kind: "oauth2" },
): ConnectorDraftDocument {
  return {
    name: slug,
    slug,
    driver: "mcp",
    environment: "prod",
    auth_type: "oauth2",
    base_url: `https://${slug}.example.test/mcp`,
    config: { mcp: { transport: "http", auth } },
  };
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

describe("saveConnectorAtomic — MCP connector that signs in interactively", () => {
  test("saves without a credential despite a 401 probe and waits for sign-in", async () => {
    const { tool } = await seed(signInDraft(mcpOAuthConnector("mcp-dcr")));

    const result = await saveConnectorAtomic({ ctx: tool, environment: "prod" });

    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sign_in).toMatchObject({
      state: "needs_sign_in",
      next_best_actions: ["request_connector_reauth"],
    });
    const row = await savedRow("mcp-dcr");
    expect(row?.needs_reauth).toBe(true);
    expect(row?.auth_failed_reason).toBe("sign_in_required");
    const vault = await ctx.db
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.tenant_id, tenant_id), eq(vaultItems.connector_id, row!.id)));
    expect(vault).toHaveLength(0);
  });

  test("a public client id from the form lands in config.mcp.auth, not in a secret", async () => {
    const { conversation_id, tool } = await seed(
      signInDraft(
        mcpOAuthConnector("mcp-public", { kind: "oauth2", issuer: "https://auth.example.test" }),
      ),
    );
    setDraftCredential(conversation_id, { mode: "oauth2", client_id: "public-client-1" });

    const result = await saveConnectorAtomic({ ctx: tool, environment: "prod" });

    expect(result.ok).toBe(true);
    const row = await savedRow("mcp-public");
    const config = row?.config as Record<string, Record<string, unknown>>;
    expect(config.mcp?.auth).toEqual({
      kind: "oauth2",
      issuer: "https://auth.example.test",
      client_id: "public-client-1",
    });
    expect(config.oauth).toBeUndefined();
    expect(row?.needs_reauth).toBe(true);
  });

  test("an http oauth2 draft still needs its credential", async () => {
    const { tool } = await seed(
      signInDraft({
        name: "http-oauth",
        slug: "http-oauth",
        driver: "http",
        environment: "prod",
        auth_type: "oauth2",
        base_url: "https://http-oauth.example.test",
      }),
    );
    const result = await saveConnectorAtomic({ ctx: tool, environment: "prod" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("credential_required");
  });
});
