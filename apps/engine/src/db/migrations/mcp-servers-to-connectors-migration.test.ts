import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { getConnectorForEnvironment } from "../../connectors/service.ts";
import {
  getCredentialForConnector,
  getOAuth2ClientCredential,
  upsertCredential,
} from "../../credentials/service.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { runMigrations } from "../migrate.ts";
import {
  auditLog,
  connectorMcpSessions,
  connectors,
  credentials,
  mcpOauthStates,
} from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

const MIGRATION_IDX = 34;

const HANDSHAKE_AT = new Date(getTestNow() - 60_000);

let ctx: TestDb;
let tenant_id: string;
let credential_id: string;
let bearer_credential_id: string;

let rovoServerId: string;
let jiraServerId: string;
let sseServerId: string;
let stdioServerId: string;
let erroredServerId: string;
let existingRovoConnectorId: string;
let existingRovoUpdatedAt: Date;
let badSlugConnectorId: string;
let pairDevConnectorId: string;
let pairProdConnectorId: string;

async function seedRows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await ctx.db.execute(query)) as unknown as { rows: T[] };
  return res.rows ?? [];
}

async function seedConnector(args: {
  slug: string;
  environment: "dev" | "prod";
  base_url: string;
}): Promise<{ id: string; updated_at: Date }> {
  const rows = await seedRows<{ id: string; updated_at: string | Date }>(
    sql`INSERT INTO connectors (tenant_id, slug, display_name, driver, environment, base_url)
        VALUES (${tenant_id}, ${args.slug}, ${args.slug}, 'http', ${args.environment}, ${args.base_url})
        RETURNING id, updated_at`,
  );
  const row = rows[0];
  if (!row) throw new Error("connector seed failed");
  return { id: row.id, updated_at: new Date(row.updated_at) };
}

async function seedMcpServer(args: {
  name: string;
  namespace: string;
  transport: "http" | "sse" | "stdio";
  url: string;
  status: "active" | "disabled" | "error";
  auth_config?: Record<string, unknown>;
  last_error?: string;
  tools_manifest_hash?: string;
  last_handshake_at?: Date;
}): Promise<string> {
  const rows = await seedRows<{ id: string }>(
    sql`INSERT INTO mcp_servers
          (tenant_id, name, namespace, transport, url, status, auth_config, last_error, tools_manifest_hash, last_handshake_at)
        VALUES (${tenant_id}, ${args.name}, ${args.namespace}, ${args.transport}, ${args.url}, ${args.status},
                ${args.auth_config ? JSON.stringify(args.auth_config) : null}::jsonb,
                ${args.last_error ?? null}, ${args.tools_manifest_hash ?? null},
                ${args.last_handshake_at ?? null})
        RETURNING id`,
  );
  const row = rows[0];
  if (!row) throw new Error("mcp server seed failed");
  return row.id;
}

beforeAll(async () => {
  ctx = await createTestDb("mcp_servers_to_connectors", { upToIdx: MIGRATION_IDX - 1 });

  const {
    rows: [t],
  } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"t-mcp-migrate"}, ${"McpMigrate"}) RETURNING id
  `);
  if (!t) throw new Error("tenant seed failed");
  tenant_id = t.id;

  const existingRovo = await seedConnector({
    slug: "rovo",
    environment: "prod",
    base_url: "https://already-here.example.test",
  });
  existingRovoConnectorId = existingRovo.id;
  existingRovoUpdatedAt = existingRovo.updated_at;

  await seedConnector({ slug: "jira", environment: "prod", base_url: "https://jira.example.test" });
  await seedConnector({
    slug: "jira-mcp",
    environment: "prod",
    base_url: "https://jira-mcp.example.test",
  });
  badSlugConnectorId = (
    await seedConnector({
      slug: "legacy__conn",
      environment: "dev",
      base_url: "https://legacy.example.test",
    })
  ).id;
  pairDevConnectorId = (
    await seedConnector({
      slug: "pair__conn",
      environment: "dev",
      base_url: "https://pair-dev.example.test",
    })
  ).id;
  pairProdConnectorId = (
    await seedConnector({
      slug: "pair__conn",
      environment: "prod",
      base_url: "https://pair-prod.example.test",
    })
  ).id;

  rovoServerId = await seedMcpServer({
    name: "Atlassian Rovo",
    namespace: "rovo",
    transport: "http",
    url: "https://mcp.atlassian.example.test/v1/sse",
    status: "disabled",
    auth_config: {
      kind: "oauth2",
      issuer: "https://auth.atlassian.example.test",
      scope: "read:jira-work",
    },
  });
  jiraServerId = await seedMcpServer({
    name: "Jira MCP",
    namespace: "jira",
    transport: "http",
    url: "https://jira-mcp.example.test/mcp",
    status: "active",
    auth_config: { kind: "bearer", token_ref: "cred" },
    tools_manifest_hash: "manifest-hash-abc",
    last_handshake_at: HANDSHAKE_AT,
  });
  sseServerId = await seedMcpServer({
    name: "Legacy SSE",
    namespace: "legacy-sse",
    transport: "sse",
    url: "https://sse.example.test/sse",
    status: "active",
  });
  stdioServerId = await seedMcpServer({
    name: "Local stdio",
    namespace: "local-stdio",
    transport: "stdio",
    url: "/usr/local/bin/some-mcp-server",
    status: "active",
  });
  erroredServerId = await seedMcpServer({
    name: "Flaky",
    namespace: "flaky",
    transport: "http",
    url: "https://flaky.example.test/mcp",
    status: "error",
    last_error: "handshake failed: 502 Bad Gateway",
  });

  const credentialCarrier = await seedConnector({
    slug: "cred-carrier",
    environment: "prod",
    base_url: "https://cred-carrier.example.test",
  });
  const credential = await upsertCredential(
    {
      tenant_id,
      connector_id: credentialCarrier.id,
      environment: "prod",
      mode: "oauth2_client",
      value: {
        mode: "oauth2_client",
        client_id: "rovo-registered-client",
        client_secret: "rovo-registration-secret",
      },
      actor_id: null,
    },
    ctx.db,
  );
  credential_id = credential.id;
  await ctx.db.execute(
    sql`UPDATE credentials
           SET connector_id = NULL, mcp_server_id = ${rovoServerId}
         WHERE id = ${credential_id}`,
  );

  const bearerCarrier = await seedConnector({
    slug: "bearer-carrier",
    environment: "prod",
    base_url: "https://bearer-carrier.example.test",
  });
  const bearerCredential = await upsertCredential(
    {
      tenant_id,
      connector_id: bearerCarrier.id,
      environment: "prod",
      mode: "bearer",
      value: { mode: "bearer", token: "sse-static-bearer-token" },
      actor_id: null,
    },
    ctx.db,
  );
  bearer_credential_id = bearerCredential.id;
  await ctx.db.execute(
    sql`UPDATE credentials
           SET connector_id = NULL, mcp_server_id = ${sseServerId}
         WHERE id = ${bearer_credential_id}`,
  );

  await ctx.db.execute(
    sql`INSERT INTO mcp_oauth_states (tenant_id, mcp_server_id, state, code_verifier, redirect_uri, expires_at)
        VALUES (${tenant_id}, ${rovoServerId}, 'pending-state-token', 'verifier',
                'https://engine.example.test/oauth/callback', ${new Date(getTestNow() + 600_000)})`,
  );

  await runMigrations(ctx.db);
}, 120_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function connectorById(id: string) {
  const [row] = await ctx.db.select().from(connectors).where(eq(connectors.id, id));
  return row;
}

test("the production row lands as a disabled mcp connector in environment prod, id preserved", async () => {
  const row = await connectorById(rovoServerId);
  expect(row).toBeDefined();
  expect(row?.driver).toBe("mcp");
  expect(row?.environment).toBe("prod");
  expect(row?.display_name).toBe("Atlassian Rovo");
  expect(row?.enabled).toBe(false);
  expect(row?.health_state).toBe("ok");
  expect(row?.last_error).toBeNull();
  expect(row?.base_url).toBe("https://mcp.atlassian.example.test/v1/sse");
});

test("the declared auth kind and the credential mode are both preserved, neither normalised", async () => {
  const row = await connectorById(rovoServerId);
  expect(row?.auth_type).toBe("oauth2");
  const config = row?.config as { mcp?: { transport?: string; auth?: { kind?: string } } };
  expect(config.mcp?.transport).toBe("http");
  expect(config.mcp?.auth?.kind).toBe("oauth2");
});

test("a credential is re-owned IN PLACE, so its ciphertext still decrypts", async () => {
  const [cred] = await ctx.db
    .select()
    .from(credentials)
    .where(eq(credentials.id, bearer_credential_id));
  expect(cred?.id).toBe(bearer_credential_id);
  expect(cred?.connector_id).toBe(sseServerId);

  const resolved = await getCredentialForConnector(tenant_id, sseServerId, "prod", ctx.db);
  expect(resolved?.value).toEqual({ mode: "bearer", token: "sse-static-bearer-token" });
});

test("the stale OAuth client registration is deleted so the next handshake re-registers", async () => {
  const [cred] = await ctx.db.select().from(credentials).where(eq(credentials.id, credential_id));
  expect(cred).toBeUndefined();
  expect(await getOAuth2ClientCredential(tenant_id, rovoServerId, "prod", ctx.db)).toBeNull();

  const [survivor] = await ctx.db
    .select()
    .from(credentials)
    .where(eq(credentials.id, bearer_credential_id));
  expect(survivor?.id).toBe(bearer_credential_id);
});

test("a taken namespace falls back deterministically instead of overwriting the http connector", async () => {
  const rovo = await connectorById(rovoServerId);
  expect(rovo?.slug).toBe("rovo-mcp");

  const jira = await connectorById(jiraServerId);
  expect(jira?.slug).toBe(`jira-${jiraServerId.replace(/-/g, "").slice(0, 8)}`);

  const untouched = await connectorById(existingRovoConnectorId);
  expect(untouched?.driver).toBe("http");
  expect(untouched?.slug).toBe("rovo");
  expect(untouched?.base_url).toBe("https://already-here.example.test");
  expect(untouched?.updated_at.getTime()).toBe(existingRovoUpdatedAt.getTime());
});

test("sse and stdio registrations are carried disabled and flagged needs_update", async () => {
  const sse = await connectorById(sseServerId);
  expect(sse?.enabled).toBe(false);
  expect(sse?.health_state).toBe("needs_update");
  expect(sse?.health_error_code).toBe("mcp_transport_unsupported");
  expect(sse?.base_url).toBe("https://sse.example.test/sse");

  const stdio = await connectorById(stdioServerId);
  expect(stdio?.enabled).toBe(false);
  expect(stdio?.health_state).toBe("needs_update");
  expect(stdio?.base_url).toBeNull();
  const config = stdio?.config as { mcp?: { command?: string } };
  expect(config.mcp?.command).toBe("/usr/local/bin/some-mcp-server");
});

test("an errored server keeps its failure text and reads as degraded", async () => {
  const row = await connectorById(erroredServerId);
  expect(row?.health_state).toBe("degraded");
  expect(row?.health_error_code).toBe("mcp_handshake_failed");
  expect(row?.last_error).toBe("handshake failed: 502 Bad Gateway");
  expect(row?.enabled).toBe(true);
});

test("only a server that actually handshook gets a session row", async () => {
  const sessions = await ctx.db.select().from(connectorMcpSessions);
  expect(sessions.map((s) => s.connector_id).sort()).toEqual([jiraServerId]);
  const [session] = sessions;
  expect(session?.tools_manifest_hash).toBe("manifest-hash-abc");
  expect(session?.last_handshake_at?.getTime()).toBe(HANDSHAKE_AT.getTime());
  expect(session?.consecutive_failures).toBe(0);
});

test("in-flight oauth state still names its connector", async () => {
  const [state] = await ctx.db
    .select()
    .from(mcpOauthStates)
    .where(eq(mcpOauthStates.state, "pending-state-token"));
  expect(state?.connector_id).toBe(rovoServerId);
  const owner = await connectorById(rovoServerId);
  expect(owner?.driver).toBe("mcp");
});

test("a pre-existing slug the shape check rejects is normalised and audited", async () => {
  const row = await connectorById(badSlugConnectorId);
  expect(row?.slug).toBe("legacy-conn");

  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.resource_id, badSlugConnectorId),
        eq(auditLog.reason, "connector_slug_shape_normalization"),
      ),
    );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.action).toBe("connector.updated");
  expect(rows[0]?.metadata).toMatchObject({
    previous_slug: "legacy__conn",
    slug: "legacy-conn",
    environment: "dev",
  });
});

async function rejectionText(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    return `${String(err)} ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

test("the slug shape check now refuses a double underscore", async () => {
  const text = await rejectionText(() =>
    ctx.db.execute(
      sql`INSERT INTO connectors (tenant_id, slug, display_name, driver) VALUES (${tenant_id}, 'bad__slug', 'Bad', 'http')`,
    ),
  );
  expect(text).toContain("connectors_slug_shape_check");
});

test("an inline mcp auth secret is refused at the storage layer", async () => {
  const text = await rejectionText(() =>
    ctx.db.execute(
      sql`INSERT INTO connectors (tenant_id, slug, display_name, driver, config)
          VALUES (${tenant_id}, 'inline-secret', 'Inline', 'mcp',
                  '{"mcp":{"transport":"http","auth":{"kind":"bearer","client_secret":"nope"}}}'::jsonb)`,
    ),
  );
  expect(text).toContain("connectors_mcp_auth_no_inline_secrets_check");
});

test("every migrated server left a reconcilable audit row", async () => {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.reason, "mcp_server_migration")));
  expect(rows).toHaveLength(5);
  const rovo = rows.find((r) => r.resource_id === rovoServerId);
  expect(rovo?.action).toBe("connector.created");
  expect(rovo?.metadata).toMatchObject({
    source_mcp_server_id: rovoServerId,
    previous_namespace: "rovo",
    slug: "rovo-mcp",
    slug_source: "namespace_mcp_suffix",
    enabled: false,
  });
});

test("a rewritten slug keeps its dev/prod sibling pairing", async () => {
  const dev = await connectorById(pairDevConnectorId);
  const prod = await connectorById(pairProdConnectorId);
  expect(dev?.slug).toBe("pair-conn");
  expect(prod?.slug).toBe("pair-conn");

  const resolved = await getConnectorForEnvironment(tenant_id, pairDevConnectorId, "prod", ctx.db);
  expect(resolved?.id).toBe(pairProdConnectorId);
});

test("re-running the migration set changes nothing", async () => {
  const before = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(connectors);
  const auditBefore = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(eq(auditLog.reason, "mcp_server_migration"));

  await runMigrations(ctx.db);

  const after = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(connectors);
  const auditAfter = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(eq(auditLog.reason, "mcp_server_migration"));
  expect(after[0]?.n).toBe(before[0]?.n);
  expect(auditAfter[0]?.n).toBe(auditBefore[0]?.n);
});
