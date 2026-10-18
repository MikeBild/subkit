import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { generateAccessToken } from "../../auth/oauth/tokens.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import type { Config } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import {
  apiKeys,
  mcpOauthAccessTokens,
  mcpOauthClients,
  sessions,
  systemAccounts,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { claimOperatorTenantIfUnassigned } from "../../rbac/operator.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-http-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/http-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

export { _resetConfigForTests };

export async function loadAuthProvidersForTest(
  providers: Config["auth"]["providers"],
  databaseUrl = "postgres://placeholder/http-test",
  opts: { enableSignup?: boolean } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sk-auth-providers-test-"));
  const file = join(dir, "subkit.config.json");
  const enable_signup = opts.enableSignup ?? true;
  await writeFile(file, JSON.stringify({ auth: { providers, enable_signup } }));
  await loadConfig({
    env: { DATABASE_URL: databaseUrl, NODE_ENV: "test" },
    configPathOverride: file,
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateApiKey() {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

export interface HttpTestServer {
  testDb: TestDb;
  db: Db;
  baseUrl: string;
  tenantId: string;
  userId: string;
  systemAccountId: string;
  apiKeyId: string;
  apiKey: string;
  cleanup: () => Promise<void>;
}

export async function browserSessionHeaders(
  ctx: Pick<HttpTestServer, "db" | "tenantId">,
  userId: string,
): Promise<Record<string, string>> {
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
      absolute_expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
    })
    .returning();
  if (!session) throw new Error("missing browser session fixture");
  const payload = { tenant_id: ctx.tenantId, user_id: userId, session_id: session.id };
  return {
    cookie: browserSessionCookie(await signBrowserSession(payload)),
    "x-subkit-csrf": await signBrowserCsrf(payload),
    "content-type": "application/json",
  };
}

export interface CreateHttpTestServerOptions {
  appOptions?: Partial<Parameters<typeof createApp>[0]>;
  operator?: boolean;
}

export async function createHttpTestServer(
  label: string,
  opts?: CreateHttpTestServerOptions,
): Promise<HttpTestServer> {
  await ensureConfigLoaded();
  const testDb = await createTestDb(`http-${label}`);

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Test ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  if (opts?.operator ?? true) await claimOperatorTenantIfUnassigned(testDb.db, tenant.id);

  const [user] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `admin-${label}@test.local`,
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("seed user failed");

  const [sysAcct] = await testDb.db
    .insert(systemAccounts)
    .values({
      tenant_id: tenant.id,
      name: `bot-${label}`,
      description: "test bot",
    })
    .returning();
  if (!sysAcct) throw new Error("seed system_account failed");

  const key = generateApiKey();
  const [apiKey] = await testDb.db
    .insert(apiKeys)
    .values({
      tenant_id: tenant.id,
      user_id: user.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["*"],
    })
    .returning();
  if (!apiKey) throw new Error("seed api_key failed");

  const registry = buildDefaultRegistry(testDb.db);
  const app = createApp({
    db: testDb.db,
    registry,
    rateLimit: { max: 10_000, windowMs: 60_000 },
    ...(opts?.appOptions ?? {}),
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") {
    throw new Error("failed to determine test server port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const cleanup = async () => {
    type CloseableServer = {
      close: (cb: () => void) => void;
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    const s = server as unknown as CloseableServer;
    s.closeIdleConnections?.();
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
    });
    await testDb.cleanup();
  };

  return {
    testDb,
    db: testDb.db,
    baseUrl,
    tenantId: tenant.id,
    userId: user.id,
    systemAccountId: sysAcct.id,
    apiKeyId: apiKey.id,
    apiKey: key.plaintext,
    cleanup,
  };
}

export interface SecondaryTenantPrincipal {
  userId: string;
  apiKey: string;
  oauthToken: string;
  sessionHeaders: () => Promise<Record<string, string>>;
}

export interface SecondaryTenant {
  tenantId: string;
  admin: SecondaryTenantPrincipal;
  member: SecondaryTenantPrincipal;
}

let secondaryTenantSeq = 0;

async function seedSecondaryPrincipal(
  ctx: Pick<HttpTestServer, "db" | "baseUrl">,
  tenantId: string,
  label: string,
  role: "admin" | "member",
): Promise<SecondaryTenantPrincipal> {
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: `${role}-${label}@secondary.test.local`,
      role_id: await builtinRoleId(ctx.db, role),
    })
    .returning();
  if (!user) throw new Error("seed secondary user failed");
  const key = generateApiKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: tenantId,
    user_id: user.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
  const clientId = `secondary-${label}-${role}`;
  await ctx.db
    .insert(mcpOauthClients)
    .values({ client_id: clientId, scope: role === "admin" ? "mcp:admin" : "mcp:read" });
  const token = generateAccessToken();
  await ctx.db.insert(mcpOauthAccessTokens).values({
    tenant_id: tenantId,
    client_id: clientId,
    user_id: user.id,
    prefix: token.prefix,
    token_sha256: token.hash,
    scope: role === "admin" ? "mcp:admin" : "mcp:read",
    resource: `${ctx.baseUrl}/mcp`,
    expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live token fixture
  });
  return {
    userId: user.id,
    apiKey: key.plaintext,
    oauthToken: token.plaintext,
    sessionHeaders: () => browserSessionHeaders({ db: ctx.db, tenantId }, user.id),
  };
}

export async function createSecondaryTenant(
  ctx: Pick<HttpTestServer, "db" | "baseUrl">,
  label = "secondary",
): Promise<SecondaryTenant> {
  const tag = `${label}-${++secondaryTenantSeq}`;
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${tag}`, display_name: `Secondary ${tag}`, is_operator: false })
    .returning();
  if (!tenant) throw new Error("seed secondary tenant failed");
  return {
    tenantId: tenant.id,
    admin: await seedSecondaryPrincipal(ctx, tenant.id, tag, "admin"),
    member: await seedSecondaryPrincipal(ctx, tenant.id, tag, "member"),
  };
}
