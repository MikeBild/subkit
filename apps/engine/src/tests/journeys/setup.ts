// Shared scaffolding for the story-driven journey tests.
//
// Every journey file starts its beforeAll hook by calling
// `createJourneyCtx(label)` which:
//
//   1. Creates a disposable Postgres database and seeds a tenant +
//      admin user + system account + admin API key.
//   2. Boots a Hono server on a random 127.0.0.1 port via `createApp`.
//   3. Starts the module-scoped pg-boss against the same database so
//      routes that call `getBoss()` (async workflow runs, inbound
//      webhooks, outbound fanout) find a live instance.
//   4. Registers every queue handler so async jobs actually drain.
//   5. Resets the in-memory mock LLM provider + webhook circuit breaker
//      so state doesn't leak between files.
//   6. Returns handles the test needs: baseUrl, mcpUrl, apiKey, db,
//      and a combined `cleanup()` that forces socket close, stops
//      pg-boss, closes the HTTP server, and drops the database.
//
// Each journey reaches the engine through its public contracts only
// (REST, MCP, chat adapters, webhook ingress, WebSocket tunnel).

import { createHash, randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import type { PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../../http/server.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { createBoss, disposeBoss, startBoss, stopBoss } from "../../queue/boss.ts";
import { registerAllHandlers } from "../../queue/handlers/index.ts";
import {
  backfillRoleIds,
  type SeededRoleIds,
  seedBuiltinRolesAndPermissions,
} from "../../rbac/seed.ts";
import { __resetAll as resetCircuitBreakers } from "../../webhooks/outbound/circuit-breaker.ts";

export interface JourneyCtx {
  tenantId: string;
  userId: string;
  systemAccountId: string;
  apiKey: string;
  baseUrl: string;
  mcpUrl: string;
  rbacRoleIds: SeededRoleIds;
  db: Db;
  boss: PgBoss;
  testDb: TestDb;
  cleanup: () => Promise<void>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

/**
 * Create a fresh per-journey context. Call once in `beforeAll`. The
 * returned ctx owns everything needed to reach the engine via its
 * public contracts.
 */
export async function createJourneyCtx(label: string): Promise<JourneyCtx> {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  resetCircuitBreakers();

  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const testDb = await createTestDb(`journey-${safeLabel}`);

  // RBAC catalog + built-in roles come online before any tenant row
  // so the journey user + system account can be assigned a real
  // `role_id` the evaluator can resolve.
  const rbacRoleIds = await seedBuiltinRolesAndPermissions(testDb.db);

  // Seed identity rows.
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `j-${safeLabel}`.slice(0, 32), display_name: `Journey ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  const [user] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `admin-${safeLabel}@test.local`,
      role: "admin",
      role_id: rbacRoleIds.admin,
    })
    .returning();
  if (!user) throw new Error("seed user failed");

  const [sysAcct] = await testDb.db
    .insert(systemAccounts)
    .values({
      tenant_id: tenant.id,
      name: `bot-${safeLabel}`,
      description: "journey bot",
      role_id: rbacRoleIds.admin,
    })
    .returning();
  if (!sysAcct) throw new Error("seed system_account failed");

  // Back-fill any rows that drop through the cracks (defense in depth).
  await backfillRoleIds(testDb.db, rbacRoleIds);

  const key = generateApiKey();
  await testDb.db.insert(apiKeys).values({
    tenant_id: tenant.id,
    user_id: user.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });

  // pg-boss at module scope so routes that reach for `getBoss()` work.
  let boss: PgBoss;
  try {
    boss = await startBoss({ connectionString: testDb.url });
  } catch {
    boss = await createBoss({ connectionString: testDb.url });
  }
  await registerAllHandlers({ boss, db: testDb.db });

  // Build a Hono app bound to this database.
  const registry = buildDefaultRegistry(testDb.db);
  const app = createApp({ db: testDb.db, registry });
  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") {
    throw new Error("failed to determine journey test server port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    tenantId: tenant.id,
    userId: user.id,
    systemAccountId: sysAcct.id,
    apiKey: key.plaintext,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    rbacRoleIds,
    db: testDb.db,
    boss,
    testDb,
    cleanup: async () => {
      // 1. Drop any idle keep-alive sockets so close() can resolve.
      const s = server as unknown as {
        close: (cb: () => void) => void;
        closeAllConnections?: () => void;
      };
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));

      // 2. Stop pg-boss.
      try {
        await stopBoss(5_000);
      } catch {
        /* ignore */
      }
      try {
        await disposeBoss(boss, 2_000);
      } catch {
        /* ignore */
      }

      // 3. Drop the database.
      await testDb.cleanup();
    },
  };
}

/** Convenience — adds bearer auth + JSON handling to `fetch`. */
export function journeyFetch(
  ctx: JourneyCtx,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ctx.apiKey}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
}

/**
 * Seed a workflow directly via DB rows. Used by journeys that need a
 * canned workflow up and running before the test begins. Goes through
 * the same tables the REST create handler touches.
 */
export async function seedWorkflow(
  ctx: JourneyCtx,
  def: { slug: string; name: string; steps: unknown[] },
): Promise<{ id: string; version_id: string }> {
  const { workflows, workflowVersions } = await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const [wf] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: def.slug,
      name: def.name,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  const [v] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: { name: def.name, slug: def.slug, steps: def.steps },
    })
    .returning();
  if (!v) throw new Error("seed workflow version failed");
  await ctx.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
  return { id: wf.id, version_id: v.id };
}
