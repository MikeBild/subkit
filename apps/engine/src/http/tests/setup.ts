// HTTP integration test scaffolding.
//
// Each test file calls `createHttpTestServer('label')` which:
//   1. spins up a per-suite disposable Postgres database via the P1 helper
//   2. seeds a tenant + admin user + system account + api key
//   3. constructs a Hono app bound to that database
//   4. starts the app on a random port using @hono/node-server
//   5. returns { baseUrl, apiKey, ..., cleanup }

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve, type ServerType } from "@hono/node-server";

import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import type { Config } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";

// Ensure the config loader is bootstrapped so route handlers that
// call getConfig() see a valid Config object. v3.5 routes assume
// loadConfig() ran in the boot path; tests that don't explicitly
// call it would 500 on the first getConfig() — this helper closes
// that gap idempotently. Subsequent tests can override values via
// setConfigKey() without re-bootstrapping.
async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    // not yet loaded — fall through.
  }
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
  // The JIT scenarios in the identity suites predate the auth.enable_signup
  // gate (production default false); gate coverage opts out explicitly.
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

export interface CreateHttpTestServerOptions {
  /** Extra `createApp` options merged over the scaffold defaults —
   *  e.g. an `agentSessionEnqueue` stub for routes that enqueue jobs. */
  appOptions?: Partial<Parameters<typeof createApp>[0]>;
}

export async function createHttpTestServer(
  label: string,
  opts?: CreateHttpTestServerOptions,
): Promise<HttpTestServer> {
  await ensureConfigLoaded();
  const testDb = await createTestDb(`http-${label}`);

  // Seed minimal identity rows.
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Test ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  const [user] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `admin-${label}@test.local`,
      role: "admin",
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

  // Build the Hono app bound to this db. We construct the registry
  // explicitly so the api_key provider also points at the test db.
  const registry = buildDefaultRegistry(testDb.db);
  // Bump the in-memory rate-limit ceiling for tests. The sweep suites
  // PUT every ConfigSchema leaf (~110 leaves and growing); the prod
  // default of 100 req/60s would 429 the trailing leaves and
  // pollute the assertions that drive `every leaf round-trips`. The
  // override is plain middleware parameterisation — no env flag, no
  // production code path branched.
  const app = createApp({
    db: testDb.db,
    registry,
    rateLimit: { max: 10_000, windowMs: 60_000 },
    ...(opts?.appOptions ?? {}),
  });

  // Bind a free port. Passing port=0 asks the kernel to pick.
  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  // node-server returns a node http.Server; pull the port from address().
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") {
    throw new Error("failed to determine test server port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const cleanup = async () => {
    // Force-close idle keep-alive sockets BEFORE close(): native bun
    // fetch holds keep-alive sockets in a pool and the server's
    // close() waits for them. On a small suite (3 tests) the pool
    // drains quickly enough that close() returns sub-second; on a
    // larger suite (10+) close() can hang past the default 5s
    // afterAll hook timeout. closeAllConnections() (Node 18+) drops
    // the pool synchronously so close() then completes immediately.
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
