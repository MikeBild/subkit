import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import { auditLog, connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import * as invokeModule from "../../llm/runtime/invoke.ts";
import { logger } from "../../logging/logger.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../../storage/object-store.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { describeOne, describePendingCatalog } from "../catalog-describe.ts";
import { result } from "./catalog-describe-fixtures.ts";

let ctx: TestDb;

const prompts: string[] = [];

let answer: (prompt: string) => unknown = () => ({ description: "x", category: "other" });

let spy: ReturnType<typeof spyOn> | null = null;

function mockModel() {
  spy = spyOn(invokeModule, "invoke").mockImplementation((async (p: {
    user_turns: Array<{ content: string }>;
  }) => {
    const prompt = p.user_turns[0]?.content ?? "";
    prompts.push(prompt);
    return result(answer(prompt));
  }) as never);
}

const store = new MemoryObjectStore();

beforeAll(async () => {
  setObjectStoreForTesting(store);
  ctx = await createTestDb("catalog_describe");
  await ctx.db
    .insert(tenants)
    .values({ slug: "t-catalog-describe", display_name: "Describe" })
    .returning();
});

afterEach(() => {
  spy?.mockRestore();
  spy = null;
  prompts.length = 0;
});

afterAll(async () => {
  setObjectStoreForTesting(null);
  await ctx.cleanup();
});

describe("a busy catalog lock", () => {
  type HeldLock = { locked: Promise<void>; release: () => void; holder: Promise<void> };

  async function seedTenant(slug: string) {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug, display_name: slug })
      .returning({ id: tenants.id });
    if (!tenant) throw new Error("Tenant missing");
    return tenant.id;
  }

  async function seedBusyConnector(tenantId: string, slug: string, human = false) {
    const [row] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenantId,
        slug,
        display_name: `Busy ${slug}`,
        driver: "http",
        base_url: "https://busy.example.test",
        ...(human
          ? {
              description: "Kept by a person.",
              description_source: "human" as const,
              category: "ops",
              category_source: "human" as const,
            }
          : {}),
      })
      .returning();
    if (!row) throw new Error("Connector missing");
    return row.id;
  }

  function holdLock(tenantId: string): HeldLock {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = ctx.db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, tenantId);
      locked.resolve();
      await release.promise;
    });
    return { locked: locked.promise, release: () => release.resolve(), holder };
  }

  async function settle(lock: HeldLock | null) {
    lock?.release();
    await lock?.holder.catch(() => {});
  }

  async function untilRetried<T>(
    warn: { mock: { calls: unknown[][] } },
    label: string,
    run: Promise<T>,
  ) {
    await Promise.race([
      run.then(
        () => undefined,
        () => undefined,
      ),
      waitFor(
        () =>
          warn.mock.calls.some(
            ([entry]) =>
              (entry as { action?: string; label?: string }).action === "retry_transient" &&
              (entry as { label?: string }).label === label,
          ),
        { label: `${label} retry`, tries: 200, sleepMs: 5 },
      ),
    ]);
  }

  async function underBriefLock<T>(tenantId: string, run: () => Promise<T>) {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const lock = holdLock(tenantId);
    try {
      await lock.locked;
      const operation = run();
      await untilRetried(warn, "catalog_describe_marker", operation);
      await settle(lock);
      return await operation;
    } finally {
      await settle(lock);
      warn.mockRestore();
    }
  }

  async function connectorRow(id: string) {
    const [row] = await ctx.db.select().from(connectors).where(eq(connectors.id, id));
    return row;
  }

  type WarnEntry = { action?: string; object_id?: string };

  function warnEntries(warn: { mock: { calls: unknown[][] } }): WarnEntry[] {
    return warn.mock.calls.map(([entry]) => entry as WarnEntry);
  }

  function warnings(entries: WarnEntry[], action: string) {
    return entries.filter((entry) => entry.action === action);
  }

  test("an unchanged object records its pass once the lock is free", async () => {
    const tenantId = await seedTenant("busy-unchanged");
    const id = await seedBusyConnector(tenantId, "busy-unchanged");
    answer = () => ({ description: "Busy API.", category: "ops" });
    mockModel();
    expect(await describeOne({ tenant_id: tenantId, kind: "connector", id }, ctx.db)).toBe(
      "described",
    );
    await ctx.db
      .update(connectors)
      .set({ catalog_described_at: sql`now() - interval '1 minute'` })
      .where(eq(connectors.id, id));
    const before = await connectorRow(id);
    const outcome = await underBriefLock(tenantId, () =>
      describeOne({ tenant_id: tenantId, kind: "connector", id }, ctx.db),
    );
    expect(outcome).toBe("unchanged");
    const after = await connectorRow(id);
    expect(after?.catalog_described_at?.getTime() ?? 0).toBeGreaterThan(
      before?.catalog_described_at?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(after?.catalog_input_hash).toBe(before?.catalog_input_hash ?? "");
    expect(prompts).toHaveLength(1);
  });

  test("an object a person owns records its skip once the lock is free", async () => {
    const tenantId = await seedTenant("busy-human");
    const id = await seedBusyConnector(tenantId, "busy-human", true);
    mockModel();
    const outcome = await underBriefLock(tenantId, () =>
      describeOne({ tenant_id: tenantId, kind: "connector", id }, ctx.db),
    );
    expect(outcome).toBe("skipped");
    expect((await connectorRow(id))?.catalog_described_at).not.toBeNull();
    expect(prompts).toHaveLength(0);
  });

  test("a model failure records its back-off once the lock is free", async () => {
    const tenantId = await seedTenant("busy-model-failure");
    const id = await seedBusyConnector(tenantId, "busy-model-failure");
    answer = () => ({ wrong: "shape" });
    mockModel();
    const outcome = await underBriefLock(tenantId, () =>
      describeOne({ tenant_id: tenantId, kind: "connector", id }, ctx.db),
    );
    expect(outcome).toBe("failed");
    const row = await connectorRow(id);
    expect(row?.catalog_described_at).not.toBeNull();
    expect(row?.catalog_input_hash).toBeNull();
  });

  test("a generated description survives a brief lock without a second model call", async () => {
    const tenantId = await seedTenant("busy-described");
    const id = await seedBusyConnector(tenantId, "busy-described");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const held: HeldLock[] = [];
    spy = spyOn(invokeModule, "invoke").mockImplementation((async () => {
      const lock = holdLock(tenantId);
      held.push(lock);
      await lock.locked;
      return result({ description: "Reads busy data.", category: "ops" });
    }) as never);
    try {
      const operation = describeOne({ tenant_id: tenantId, kind: "connector", id }, ctx.db);
      await untilRetried(warn, "catalog_describe_apply", operation);
      for (const lock of held) await settle(lock);
      expect(await operation).toBe("described");
    } finally {
      for (const lock of held) await settle(lock);
      warn.mockRestore();
    }
    expect(held).toHaveLength(1);
    const row = await connectorRow(id);
    expect(row?.description).toBe("Reads busy data.");
    expect(row?.category).toBe("ops");
    await _drainAuditWritesForTests();
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "catalog_metadata.generated"),
          eq(auditLog.resource_id, id),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  test("a lock held for the whole pass fails each object but never the batch", async () => {
    const tenantId = await seedTenant("busy-batch");
    const first = await seedBusyConnector(tenantId, "busy-batch-a");
    const second = await seedBusyConnector(tenantId, "busy-batch-b");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const held: HeldLock[] = [];
    spy = spyOn(invokeModule, "invoke").mockImplementation((async () => {
      if (held.length === 0) {
        const lock = holdLock(tenantId);
        held.push(lock);
        await lock.locked;
      }
      return result({ description: "Never stored.", category: "ops" });
    }) as never);
    let run: Awaited<ReturnType<typeof describePendingCatalog>> | null = null;
    let entries: WarnEntry[] = [];
    try {
      run = await describePendingCatalog(tenantId, ctx.db);
    } finally {
      entries = warnEntries(warn);
      for (const lock of held) await settle(lock);
      warn.mockRestore();
    }
    expect(run?.failed).toBe(2);
    expect(run?.described).toBe(0);
    expect(
      warnings(entries, "catalog.describe_failed")
        .map((entry) => entry.object_id)
        .sort(),
    ).toEqual([first, second].sort());
    expect(warnings(entries, "catalog.describe_backoff_failed")).toHaveLength(2);
  });

  test("another tenant's lock never slows this tenant's pass", async () => {
    const busyTenant = await seedTenant("busy-other-a");
    const freeTenant = await seedTenant("busy-other-b");
    await seedBusyConnector(freeTenant, "busy-other-free");
    answer = () => ({ description: "Free API.", category: "ops" });
    mockModel();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const lock = holdLock(busyTenant);
    let run: Awaited<ReturnType<typeof describePendingCatalog>> | null = null;
    let entries: WarnEntry[] = [];
    try {
      await lock.locked;
      run = await describePendingCatalog(freeTenant, ctx.db);
    } finally {
      entries = warnEntries(warn);
      await settle(lock);
      warn.mockRestore();
    }
    expect(run?.described).toBe(1);
    expect(run?.failed).toBe(0);
    expect(warnings(entries, "retry_transient")).toHaveLength(0);
  });
});
