import { afterAll, beforeAll, beforeEach } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { Request as BossRequest, PgBoss, SendOptions } from "pg-boss";
import {
  auditLog,
  connectors,
  knowledgeSources,
  schedulerSweepCursors,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";

export const uuid = createDeterministicUuidFactory(0x5c0ef123);

export const now = new Date(getTestNow());

export let fixture: TestDb;

export let boss: PgBoss;

export let tenantId: string;

export async function addDocs(
  config: Record<string, unknown>,
  cron = "every:60",
  tenant_id = tenantId,
) {
  const id = uuid();
  await fixture.db.insert(connectors).values({
    id,
    tenant_id,
    slug: id,
    display_name: "Refresh fixture",
    driver: "http",
    config,
    auto_refresh_cron: cron,
    created_at: now,
  });
  return id;
}

export async function addKnowledge(
  address = "https://example.test/knowledge",
  source_type = "url",
  tenant_id = tenantId,
) {
  const id = uuid();
  await fixture.db.insert(knowledgeSources).values({
    id,
    tenant_id,
    name: "Refresh fixture",
    slug: id,
    version: "fixture",
    source_type,
    source_uri: address,
    refresh_strategy: "scheduled",
    refresh_cron: "every:60",
    created_at: now,
  });
  return id;
}

export function docsConfig() {
  return { docs_source_type: "openapi", docs_source_url: "https://example.test/docs" };
}

export async function docsStamp(id: string) {
  const [row] = await fixture.db
    .select({ at: connectors.last_ingested_at })
    .from(connectors)
    .where(and(eq(connectors.id, id), eq(connectors.tenant_id, tenantId)));
  return row?.at;
}

export async function knowledgeStamp(id: string) {
  const [row] = await fixture.db
    .select({ at: knowledgeSources.last_refreshed_at })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.id, id), eq(knowledgeSources.tenant_id, tenantId)));
  return row?.at;
}

export function interceptSend(
  send: PgBoss["send"],
  after: (jobId: string | null, options?: SendOptions) => Promise<void>,
): PgBoss["send"] {
  async function intercepted(request: BossRequest): Promise<string | null>;
  async function intercepted(
    name: string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null>;
  async function intercepted(
    request: BossRequest | string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null> {
    const result =
      typeof request === "string" ? await send(request, data, options) : await send(request);
    await after(result, typeof request === "string" ? options : request.options);
    return result;
  }
  return intercepted;
}

export function databaseCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== "object") return undefined;
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export async function reached(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        // allow-wall-clock: bounded watchdog for an actual PostgreSQL barrier
        timer = setTimeout(() => reject(new Error("fixture_barrier_not_reached")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function admissionReceipts() {
  return fixture.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "scheduler.sweep_queue_admitted"));
}

export function useRefreshProducerDb(): void {
  beforeAll(async () => {
    fixture = await createTestDb("refresh_sweep");
    boss = await createBoss({ connectionString: fixture.url, schema: "refresh_jobs" });
  }, TEST_DB_HOOK_TIMEOUT);
  beforeEach(async () => {
    await boss.deleteAllJobs();
    await fixture.db.delete(tenants);
    await fixture.db.delete(auditLog);
    await fixture.db.update(schedulerSweepCursors).set({
      epoch: 0,
      revision: 0,
      after_id: null,
      epoch_upper_id: null,
      epoch_cutoff_at: null,
      lease_owner_boot_id: null,
      lease_token: null,
      lease_until: null,
      updated_at: sql`date_trunc('milliseconds', clock_timestamp())`,
    });
    tenantId = uuid();
    await fixture.db
      .insert(tenants)
      .values({ id: tenantId, slug: tenantId, display_name: "Refresh tenant", created_at: now });
  });
  afterAll(async () => {
    if (boss) await disposeBoss(boss);
    if (fixture) await fixture.cleanup();
  }, TEST_DB_HOOK_TIMEOUT);
}
