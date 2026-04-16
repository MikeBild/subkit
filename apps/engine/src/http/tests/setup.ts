// HTTP integration test scaffolding.
//
// Each test file calls `createHttpTestServer('label')` which:
//   1. spins up a per-suite disposable Postgres database via the P1 helper
//   2. seeds a tenant + admin user + system account + api key
//   3. constructs a Hono app bound to that database
//   4. starts the app on a random port using @hono/node-server
//   5. returns { baseUrl, apiKey, ..., cleanup }

import { createHash, randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import type { Db } from "../../db/client.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";

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

export async function createHttpTestServer(label: string): Promise<HttpTestServer> {
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
  const app = createApp({ db: testDb.db, registry });

  // Bind a free port. Passing port=0 asks the kernel to pick.
  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  // node-server returns a node http.Server; pull the port from address().
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") {
    throw new Error("failed to determine test server port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const cleanup = async () => {
    await new Promise<void>((resolve) => {
      (server as unknown as { close: (cb: () => void) => void }).close(() => resolve());
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
