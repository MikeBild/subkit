import { afterEach, describe, expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { ALWAYS_RUNNING, type BackgroundWork, createPowerState } from "./power-state.ts";
import { SchedulerReconciler } from "./reconciler.ts";

const touched: string[] = [];
const untouchable = new Proxy({} as Db, {
  get(_target, property) {
    touched.push(String(property));
    throw new Error(`database touched: ${String(property)}`);
  },
});

function reconciler(backgroundWork?: BackgroundWork): SchedulerReconciler {
  return new SchedulerReconciler({
    db: untouchable,
    boss: {} as PgBoss,
    discoveryRunner: async () => {
      throw new Error("discovery ran");
    },
    ...(backgroundWork ? { backgroundWork } : {}),
  });
}

afterEach(() => {
  touched.length = 0;
});

describe("background work on battery", () => {
  test("runs by default and can be deferred and resumed", () => {
    expect(ALWAYS_RUNNING.deferred()).toBe(false);
    const power = createPowerState();
    expect(power.deferred()).toBe(false);
    power.defer(true);
    expect(power.deferred()).toBe(true);
    power.defer(false);
    expect(power.deferred()).toBe(false);
  });

  test("each power state stands alone", () => {
    const first = createPowerState();
    const second = createPowerState();
    first.defer(true);
    expect(second.deferred()).toBe(false);
  });

  test("deferred passes do not touch the database", async () => {
    const power = createPowerState();
    power.defer(true);
    const scheduler = reconciler(power);
    const now = new Date(Date.UTC(2026, 10, 21, 12, 0, 0));
    await scheduler.reconcileEmbeddingBackfill(now);
    await scheduler.reconcileConnectorSelfDescription(now);
    await scheduler.reconcileSkillCandidateAnalysis(now);
    await scheduler.reconcileCatalogDescribe();
    await scheduler.reconcileProactiveDriftScans(now);
    await scheduler.reconcileEndpointContractScans(now);
    await scheduler.reconcileDocsAutoRefresh();
    await scheduler.reconcileKnowledgeAutoRefresh();
    expect(touched).toEqual([]);
  });

  test("on mains power the same pass reaches the database", async () => {
    const scheduler = reconciler();
    await expect(
      scheduler.reconcileSkillCandidateAnalysis(new Date(Date.UTC(2026, 10, 21, 12, 0, 0))),
    ).rejects.toThrow();
    expect(touched.length).toBeGreaterThan(0);
  });
});
