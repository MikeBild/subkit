import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import type { PgBoss } from "pg-boss";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../../http/server.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { logger } from "../../logging/index.ts";
import { createBoss, disposeBoss, startBoss, stopBoss } from "../../queue/boss.ts";
import { registerAllHandlers } from "../../queue/handlers/index.ts";
import { claimOperatorTenantIfUnassigned } from "../../rbac/operator.ts";
import {
  backfillSystemAccountRoleIds,
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
  TEST_MASTER_KEY,
  withTestEnv,
} from "../../test-helpers/determinism/index.ts";
import { __resetAll as resetCircuitBreakers } from "../../webhooks/outbound/circuit-breaker.ts";

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
  clock: DeterministicClock;
  ids: IdFactory;
  random: SeededRandom;
  cleanup: () => Promise<void>;
}

interface CreateJourneyOpts {
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

async function ensureConfigLoaded(databaseUrl: string): Promise<void> {
  try {
    getConfig();
  } catch {
    const dir = mkdtempSync(join(tmpdir(), "sk-cfg-journey-"));
    await loadConfig({
      env: { DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      configPathOverride: join(dir, "subkit.config.json"),
    });
  }
  if (!getConfig().storage.object_store.bucket) {
    await setConfigKey("storage.object_store.bucket", "test", { force: true });
  }
}

export async function createJourneyCtx(
  label: string,
  opts: CreateJourneyOpts = {},
): Promise<JourneyCtx> {
  const envHandle: EnvHandle = withTestEnv({
    LLM_PROVIDER: "mock",
    MASTER_KEY: TEST_MASTER_KEY,
    ...opts.envOverrides,
  });
  resetMockProvider();
  resetCircuitBreakers();

  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const seed = seedFromEnv(hashStringToSeed(safeLabel));
  const clock = createDeterministicClock();
  const ids = createDeterministicIdFactory(`j-${safeLabel}`);
  const random = createSeededRandom(seed);

  const failSafe: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "env-handle", fn: async () => envHandle.restore() },
  ];
  const fail = async (err: unknown): Promise<never> => {
    for (const step of failSafe.reverse()) {
      try {
        await step.fn();
      } catch {}
    }
    throw err;
  };

  let testDb: TestDb;
  try {
    testDb = await createTestDb(`journey-${safeLabel}`);
    failSafe.push({ name: "test-db", fn: () => testDb.cleanup() });
  } catch (e) {
    await fail(e);
    throw e;
  }

  try {
    await ensureConfigLoaded(testDb.url);
  } catch (e) {
    await fail(e);
    throw e;
  }

  try {
    const rbacRoleIds = await seedBuiltinRolesAndPermissions(testDb.db);

    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: `j-${safeLabel}`.slice(0, 32), display_name: `Journey ${label}` })
      .returning();
    if (!tenant) throw new Error("seed tenant failed");
    await claimOperatorTenantIfUnassigned(testDb.db, tenant.id);

    const [user] = await testDb.db
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: `admin-${safeLabel}@test.local`,
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

    await backfillSystemAccountRoleIds(testDb.db, rbacRoleIds);

    const key = generateApiKey();
    await testDb.db.insert(apiKeys).values({
      tenant_id: tenant.id,
      user_id: user.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["*"],
    });

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

    const registry = buildDefaultRegistry(testDb.db);
    const app = createApp({ db: testDb.db, registry });
    const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
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
    throw e;
  }
}

function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

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
