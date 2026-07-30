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
// (REST, MCP, chat adapters, webhook ingress).

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import type { PgBoss } from "pg-boss";
import { getConfig, loadConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../../http/server.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { logger } from "../../logging/logger.ts";
import { createBoss, disposeBoss, startBoss, stopBoss } from "../../queue/boss.ts";
import { registerAllHandlers } from "../../queue/handlers/index.ts";
import {
  backfillRoleIds,
  type SeededRoleIds,
  seedBuiltinRolesAndPermissions,
} from "../../rbac/seed.ts";
import {
  createDeterministicClock,
  createDeterministicIdFactory,
  createSeededRandom,
  type DeterministicClock,
  type EnvHandle,
  type IdFactory,
  type SeededRandom,
  seedFromEnv,
  withTestEnv,
} from "../../test-helpers/determinism/index.ts";
import { __resetAll as resetCircuitBreakers } from "../../webhooks/outbound/circuit-breaker.ts";

/** Per-hook timeout for every journey `beforeAll` / `afterAll`. Set
 *  high enough that a slow pg-boss shutdown or test-db drop names
 *  itself in the structured `journey.teardown.step` log line below
 *  rather than surfacing as a generic Bun hook timeout.
 *
 *  Bumped to 120s after a `verify` gate run showed `DROP DATABASE`
 *  steps queueing behind concurrent admin operations at
 *  `--max-concurrency=4` — the 60s budget was being consumed entirely
 *  by the postgres-side teardown serialisation, not by anything the
 *  journey itself does. The 120s ceiling preserves the observability
 *  contract (slow steps still surface in the teardown_step log) while
 *  giving Postgres headroom to drop a 100-table database under load.
 */
export const JOURNEY_HOOK_TIMEOUT = 120_000;

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
  /** Deterministic clock for this journey. Advance with `advanceBy`. */
  clock: DeterministicClock;
  /** Scoped id factory for this journey. */
  ids: IdFactory;
  /** Seeded PRNG for this journey. */
  random: SeededRandom;
  cleanup: () => Promise<void>;
}

export interface CreateJourneyOpts {
  /** Extra process.env overrides applied for the duration of the
   *  journey. Restored on cleanup. `LLM_PROVIDER=mock` is always set. */
  envOverrides?: Record<string, string | undefined>;
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
 * public contracts. Cleanup is fail-safe: a partial setup failure still
 * tears down what was created.
 */
/** Bootstrap the per-process config loader once. Route handlers that
 *  call `getConfig()` (e.g. `POST /v1/files/inline` →
 *  `composeStorageUri` → `getConfig().storage`) would otherwise 500 on
 *  the first request because no journey ever ran the engine boot path
 *  that calls `loadConfig()`. Idempotent — a probe via `getConfig()`
 *  short-circuits subsequent invocations from later journey files.
 *
 *  Takes the resolved testcontainer DATABASE_URL so `getPool()`'s
 *  env-first resolution (see `db/client.ts:getPool`) lands on the real
 *  disposable db, not a placeholder. Must run AFTER `withTestEnv`
 *  pins `DATABASE_URL` for the journey. */
async function ensureConfigLoaded(databaseUrl: string): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    // not yet loaded — fall through.
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-journey-"));
  await loadConfig({
    env: { DATABASE_URL: databaseUrl, NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

export async function createJourneyCtx(
  label: string,
  opts: CreateJourneyOpts = {},
): Promise<JourneyCtx> {
  const envHandle: EnvHandle = withTestEnv({
    LLM_PROVIDER: "mock",
    ...opts.envOverrides,
  });
  resetMockProvider();
  resetCircuitBreakers();

  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const seed = seedFromEnv(hashStringToSeed(safeLabel));
  const clock = createDeterministicClock();
  const ids = createDeterministicIdFactory(`j-${safeLabel}`);
  const random = createSeededRandom(seed);

  // Track what's been created so a mid-setup failure can still tear
  // down the partial state. Each entry is named so a flaky teardown
  // on CI tells us which step ran long instead of just timing out.
  const failSafe: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "env-handle", fn: async () => envHandle.restore() },
  ];
  const fail = async (err: unknown): Promise<never> => {
    for (const step of failSafe.reverse()) {
      try {
        await step.fn();
      } catch {
        /* swallow — teardown best-effort */
      }
    }
    throw err;
  };

  let testDb: TestDb;
  try {
    testDb = await createTestDb(`journey-${safeLabel}`);
    failSafe.push({ name: "test-db", fn: () => testDb.cleanup() });
  } catch (e) {
    await fail(e);
    throw e; // unreachable
  }

  // Bootstrap the config loader against the resolved testcontainer URL —
  // see ensureConfigLoaded's doc-comment for the ordering contract.
  try {
    await ensureConfigLoaded(testDb.url);
  } catch (e) {
    await fail(e);
    throw e; // unreachable
  }

  try {
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
    failSafe.push({
      name: "pg-boss",
      fn: async () => {
        try {
          await stopBoss(5_000);
        } catch {}
        try {
          await disposeBoss(boss);
        } catch {}
      },
    });
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
    failSafe.push({
      name: "http-server",
      fn: async () => {
        const s = server as unknown as {
          close: (cb: () => void) => void;
          closeAllConnections?: () => void;
        };
        s.closeAllConnections?.();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      },
    });

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
      clock,
      ids,
      random,
      cleanup: async () => {
        // Run the registered teardown stack in reverse order. Each
        // step swallows errors so one failing step can't block the
        // rest of cleanup. Per-step duration is emitted on every run
        // (not just under SUBKIT_JOURNEY_TEARDOWN_DIAG) — that way a
        // CI flake names the slow step in the existing log stream
        // instead of requiring a re-run with the env var set.
        for (const step of failSafe.reverse()) {
          // allow-wall-clock: duration delta for observability — not a
          // timestamp consumed by the SUT. The tests/journey logger
          // line below records elapsed teardown time so a CI flake
          // names the slow step; both reads are local to this for-loop.
          const t = Date.now();
          let error: unknown;
          try {
            await step.fn();
          } catch (err) {
            error = err;
          }
          const duration_ms = Date.now() - t; // allow-wall-clock: see comment above
          logger.info({
            module: "tests.journey",
            action: "teardown.step",
            msg: "journey teardown step finished",
            journey: label,
            step: step.name,
            duration_ms,
            ...(error instanceof Error
              ? { error: error.message }
              : error
                ? { error: String(error) }
                : {}),
          });
        }
      },
    };
  } catch (e) {
    await fail(e);
    throw e; // unreachable
  }
}

/** Hash a short ASCII label to a stable 32-bit seed. Used when the
 *  caller doesn't override via SUBKIT_DETERMINISTIC_SEED. */
function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
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
