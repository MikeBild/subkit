import { expect, spyOn, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import { type ReconcilerOptions, SchedulerReconciler } from "../reconciler.ts";

const passMethods = [
  "reconcileEverySchedules",
  "reconcileDocsAutoRefresh",
  "reconcileKnowledgeAutoRefresh",
  "reconcileWorkflowSchedules",
  "reconcileProactiveDriftScans",
  "reconcileConnectorReauthScans",
  "reconcileEndpointContractScans",
  "reconcileSkillCandidateAnalysis",
  "reconcileCatalogDescribe",
  "reconcileConnectorSelfDescription",
  "reconcileFilesCleanup",
  "reconcileMcpOAuthCleanup",
  "reconcileConnectionRefresh",
  "reconcileConversationTitleSweep",
  "reconcileChatDedupCleanup",
  "reconcileNotificationInboxRetention",
  "reconcileToolApprovalsCleanup",
  "reconcileElicitationExpiry",
  "reconcileRiskSignalEdges",
  "reconcileEmbeddingBackfill",
] as const;

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function probe(intervalMs?: number) {
  const db = {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: async () => [] }) }),
    }),
  } as unknown as Db;
  const reconciler = new SchedulerReconciler({ db, intervalMs } as ReconcilerOptions);
  const passes = Object.fromEntries(
    passMethods.map((method) => [method, spyOn(reconciler, method).mockResolvedValue()]),
  );
  return { reconciler, passes, db };
}

test("a pending producer does not hold other families or the next tick and stays owned until stop drains", async () => {
  const blocked = deferred();
  const entered = deferred();
  const progressed = deferred();
  const { reconciler, passes } = probe();
  const reachedTail = deferred();
  passes.reconcileEmbeddingBackfill?.mockImplementation(async () => reachedTail.resolve());
  passes.reconcileDocsAutoRefresh?.mockImplementation(async () => {
    entered.resolve();
    await blocked.promise;
  });
  passes.reconcileProactiveDriftScans?.mockImplementation(async () => progressed.resolve());
  let firstFinished = false;
  const first = reconciler.reconcileOnce().then(() => {
    firstFinished = true;
  });
  try {
    await entered.promise;
    await progressed.promise;
    await reachedTail.promise;
    await reconciler.reconcileOnce();
    expect(firstFinished).toBe(false);
    expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(1);
    expect(passes.reconcileProactiveDriftScans).toHaveBeenCalledTimes(2);
    expect(passes.reconcileToolApprovalsCleanup).toHaveBeenCalledTimes(2);
    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await reconciler.reconcileOnce();
    expect(passes.reconcileProactiveDriftScans).toHaveBeenCalledTimes(2);
    blocked.resolve();
    await first;
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    blocked.resolve();
    await first;
    await reconciler.stop();
  }
});

test("a failed producer releases only its own family and is retried on the next tick", async () => {
  const blocked = deferred();
  const entered = deferred();
  const { reconciler, passes } = probe();
  const reachedTail = deferred();
  passes.reconcileEmbeddingBackfill?.mockImplementation(async () => reachedTail.resolve());
  passes.reconcileDocsAutoRefresh?.mockImplementationOnce(async () => {
    entered.resolve();
    await blocked.promise;
  });
  const first = reconciler.reconcileOnce();
  try {
    await entered.promise;
    await reachedTail.promise;
    await reconciler.reconcileOnce();
    expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(1);
    blocked.reject(new Error("fixed producer failure"));
    await first;
    await reconciler.reconcileOnce();
    expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(2);
    expect(passes.reconcileKnowledgeAutoRefresh).toHaveBeenCalledTimes(3);
    expect(passes.reconcileCatalogDescribe).toHaveBeenCalledTimes(3);
  } finally {
    blocked.resolve();
    await first;
    await reconciler.stop();
  }
});

test("startup installs recurring ticks while its first producer is still pending", async () => {
  const blocked = deferred();
  const repeated = deferred();
  const { reconciler, passes } = probe(5);
  passes.reconcileDocsAutoRefresh?.mockImplementation(async () => blocked.promise);
  let healthyVisits = 0;
  passes.reconcileProactiveDriftScans?.mockImplementation(async () => {
    if (++healthyVisits >= 2) repeated.resolve();
  });
  let started = false;
  const starting = reconciler.start().then(() => {
    started = true;
  });
  try {
    await repeated.promise;
    expect(started).toBe(false);
    expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(1);
    expect(healthyVisits).toBeGreaterThanOrEqual(2);
    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    blocked.resolve();
    await starting;
    await stopping;
    expect(stopped).toBe(true);
    const settledVisits = healthyVisits;
    await reconciler.reconcileOnce();
    expect(healthyVisits).toBe(settledVisits);
  } finally {
    blocked.resolve();
    await starting;
    await reconciler.stop();
  }
});

test("failed startup removes the interval it installed", async () => {
  const { reconciler, passes } = probe(5);
  passes.reconcileEverySchedules?.mockRejectedValue(new Error("fixed schedule read failure"));
  try {
    await expect(reconciler.start()).rejects.toThrow("fixed schedule read failure");
    const calls = passes.reconcileCatalogDescribe?.mock.calls.length;
    await Bun.sleep(20);
    expect(passes.reconcileCatalogDescribe).toHaveBeenCalledTimes(calls ?? 0);
  } finally {
    await reconciler.stop();
  }
});

test("installation acknowledges the interval before starting work and owns one first pass", async () => {
  const blocked = deferred();
  const entered = deferred();
  const { reconciler, passes } = probe();
  passes.reconcileDocsAutoRefresh?.mockImplementation(async () => {
    entered.resolve();
    await blocked.promise;
  });
  const handle = reconciler.install();
  try {
    expect(handle.installed).toBe(true);
    expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(0);
    expect(reconciler.install()).toBe(handle);
    await entered.promise;
    const stopping = reconciler.stop();
    expect(() => reconciler.install()).toThrow("scheduler_stopping");
    blocked.resolve();
    await handle.firstPass;
    await stopping;
    expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(1);
    const restarted = reconciler.install();
    expect(restarted).not.toBe(handle);
    await restarted.firstPass;
    expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(2);
  } finally {
    blocked.resolve();
    await handle.firstPass;
    await reconciler.stop();
  }
});

test("stop immediately after installation prevents the deferred first pass from admitting work", async () => {
  const { reconciler, passes } = probe();
  const handle = reconciler.install();
  await reconciler.stop();
  await handle.firstPass;
  expect(passes.reconcileDocsAutoRefresh).toHaveBeenCalledTimes(0);
  expect(passes.reconcileCatalogDescribe).toHaveBeenCalledTimes(0);
});
