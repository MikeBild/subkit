// pg-boss client factory + lifecycle helpers.
//
// Keeps a single module-scoped PgBoss instance so the rest of the engine
// can `getBoss()` after `startBoss()` has resolved. Tests may start a
// dedicated instance via `createBoss()` against an isolated database.

import type { ConstructorOptions, QueueResult } from "pg-boss";
import { PgBoss } from "pg-boss";
import { logger } from "../logging/logger.ts";
import { setDlqJobCount, setQueueDepth, setQueueLag } from "../observability/instrumentation.ts";
import { QUEUE_DEFINITIONS, QUEUE_NAMES, type QueueName } from "./queues.ts";

let _boss: PgBoss | null = null;
let _depthPoller: NodeJS.Timeout | null = null;
const QUEUE_DEPTH_POLL_INTERVAL_MS = 15_000;

async function pollQueueDepths(boss: PgBoss): Promise<void> {
  try {
    const queues = (await boss.getQueues()) as QueueResult[];
    for (const q of queues) {
      setQueueDepth(q.name, q.queuedCount ?? 0);
      // Phase 2: dead-letter depth. A growing `*.dlq` queue means a worker
      // is failing every attempt for some payload class — a leading
      // maintenance signal distinct from steady-state queue depth.
      if (q.name.endsWith(".dlq")) {
        setDlqJobCount(q.name, q.queuedCount ?? 0);
      }
      // pg-boss exposes per-queue `updatedOn` rather than oldest-pending
      // age. Use `updatedOn` as a proxy for "queue idle since" — if the
      // queue is empty this stays small; if jobs are stuck it grows.
      if (q.updatedOn) {
        const ms = new Date(q.updatedOn).getTime();
        if (Number.isFinite(ms) && (q.queuedCount ?? 0) > 0) {
          setQueueLag(q.name, Math.max(0, Date.now() - ms));
        } else {
          setQueueLag(q.name, 0);
        }
      }
    }
  } catch (err) {
    logger.warn({
      module: "queue",
      action: "boss.depth_poll_failed",
      msg: "queue depth poll failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function startDepthPoller(boss: PgBoss): void {
  if (_depthPoller) return;
  // Fire once immediately so the first scrape after boot has values.
  void pollQueueDepths(boss);
  _depthPoller = setInterval(() => {
    void pollQueueDepths(boss);
  }, QUEUE_DEPTH_POLL_INTERVAL_MS);
  // Don't keep the event loop alive on its own.
  (_depthPoller as unknown as { unref?: () => void }).unref?.();
}

function stopDepthPoller(): void {
  if (_depthPoller) {
    clearInterval(_depthPoller);
    _depthPoller = null;
  }
}

export interface StartBossOptions {
  connectionString: string;
  schema?: string;
}

/**
 * Create a PgBoss instance without attaching it to module scope. Tests
 * use this to run against a disposable database.
 */
export async function createBoss(opts: StartBossOptions): Promise<PgBoss> {
  const bossOptions: ConstructorOptions = {
    connectionString: opts.connectionString,
    schema: opts.schema ?? "pgboss",
    // Keep clocks reasonable in test + prod. pg-boss asserts these.
    cronMonitorIntervalSeconds: 5,
    cronWorkerIntervalSeconds: 2,
  };
  const boss = new PgBoss(bossOptions);

  boss.on("error", (err: Error) => {
    logger.error({
      module: "queue",
      action: "boss.error",
      msg: "pg-boss emitted error",
      error: err.message,
    });
  });

  await boss.start();

  // Register every queue up-front so subsequent `send()` calls against
  // queues that have no consumer yet still succeed. DLQs must exist
  // before their owning queue references them via `deadLetter`.
  const existing = new Set((await boss.getQueues()).map((q: QueueResult) => q.name));
  // DLQs must exist before their owning queue references them via
  // `deadLetter`. Collected from every queue definition so a new queue
  // with a dead-letter target is wired up without a manual edit here.
  const deadLetters = new Set<string>();
  for (const name of QUEUE_NAMES) {
    const dl = QUEUE_DEFINITIONS[name as QueueName].queue.deadLetter;
    if (dl) deadLetters.add(dl);
  }
  for (const dlq of deadLetters) {
    if (existing.has(dlq)) continue;
    try {
      await boss.createQueue(dlq);
      existing.add(dlq);
    } catch (err) {
      logger.warn({
        module: "queue",
        action: "queue.create_failed",
        msg: "could not create DLQ",
        queue: dlq,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const name of QUEUE_NAMES) {
    if (existing.has(name)) continue;
    const def = QUEUE_DEFINITIONS[name as QueueName];
    try {
      await boss.createQueue(name, def.queue);
      existing.add(name);
    } catch (err) {
      logger.warn({
        module: "queue",
        action: "queue.create_failed",
        msg: "could not create queue (ignoring — probably exists)",
        queue: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info({
    module: "queue",
    action: "boss.started",
    msg: "pg-boss started",
    queues: QUEUE_NAMES.length,
  });
  return boss;
}

/** Start the shared module-scoped boss. Idempotent. */
export async function startBoss(opts: StartBossOptions): Promise<PgBoss> {
  if (_boss) return _boss;
  _boss = await createBoss(opts);
  startDepthPoller(_boss);
  return _boss;
}

export function getBoss(): PgBoss {
  if (!_boss) {
    throw new Error("pg-boss has not been started — call startBoss() first");
  }
  return _boss;
}

export async function stopBoss(timeoutMs = 10_000): Promise<void> {
  if (!_boss) return;
  const boss = _boss;
  _boss = null;
  stopDepthPoller();
  try {
    await boss.stop({ graceful: true, timeout: timeoutMs, close: true });
  } catch (err) {
    logger.warn({
      module: "queue",
      action: "boss.stop_failed",
      msg: "pg-boss stop threw",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info({
    module: "queue",
    action: "boss.stopped",
    msg: "pg-boss stopped",
  });
}

/**
 * Stop a test-owned pg-boss immediately, without draining.
 *
 * This is the TEST teardown path — `stopBoss` remains the graceful
 * production shutdown and is unchanged. A suite has nothing to drain: its
 * disposable database is dropped moments later, so an in-flight job is
 * discarded either way. `graceful: true` polls `hasPendingCleanups()`
 * every 500ms until the timeout expires, and under load that reliably
 * spent the entire budget — the teardown was abandoned and a live worker
 * set stayed registered against a database the next suite no longer owned.
 * Authority: `apps/engine/src/queue/tests/dispose-boss.test.ts`.
 */
export async function disposeBoss(boss: PgBoss): Promise<void> {
  try {
    await boss.stop({ graceful: false, close: true });
  } catch {
    /* ignore */
  }
}
