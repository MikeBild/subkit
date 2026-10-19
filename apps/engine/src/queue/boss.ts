import type { Db as BossDb, ConstructorOptions, QueueResult } from "pg-boss";
import { PgBoss } from "pg-boss";
import { databasePoolOptions } from "../db/connection-options.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { setDlqJobCount, setQueueDepth, setQueueLag } from "../observability/instrumentation.ts";
import { queueErrorFields } from "./error-fields.ts";
import { QUEUE_DEFINITIONS, QUEUE_NAMES, type QueueName } from "./queues.ts";

const ownedBossSchemas = new WeakMap<PgBoss, string>();

export function createBossReadOnlyReader(boss: PgBoss, db: BossDb): PgBoss {
  const schema = ownedBossSchemas.get(boss);
  if (!schema) throw new Error("queue_reader_owner_unknown");
  return new PgBoss({
    db,
    schema,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
    useListenNotify: false,
  });
}

let _boss: PgBoss | null = null;
let _depthPoller: NodeJS.Timeout | null = null;
const QUEUE_DEPTH_POLL_INTERVAL_MS = 15_000;

async function pollQueueDepths(boss: PgBoss): Promise<void> {
  try {
    const queues = (await boss.getQueues()) as QueueResult[];
    for (const q of queues) {
      setQueueDepth(q.name, q.queuedCount ?? 0);
      if (q.name.endsWith(".dlq")) {
        setDlqJobCount(q.name, q.queuedCount ?? 0);
      }
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
      ...errorFields(err),
    });
  }
}

function startDepthPoller(boss: PgBoss): void {
  if (_depthPoller) return;
  void pollQueueDepths(boss);
  _depthPoller = setInterval(() => {
    void pollQueueDepths(boss);
  }, QUEUE_DEPTH_POLL_INTERVAL_MS);
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

export async function createBoss(opts: StartBossOptions): Promise<PgBoss> {
  const bossOptions: ConstructorOptions = {
    ...databasePoolOptions(opts.connectionString),
    schema: opts.schema ?? "pgboss",
    useListenNotify: false,
    schedule: false,
    cronMonitorIntervalSeconds: 5,
    cronWorkerIntervalSeconds: 2,
  };
  const boss = new PgBoss(bossOptions);
  ownedBossSchemas.set(boss, bossOptions.schema ?? "pgboss");

  boss.on("error", (err: unknown) => {
    logger.error({
      module: "queue",
      action: "boss.error",
      msg: "pg-boss emitted error",
      ...queueErrorFields(err),
    });
  });

  await boss.start();

  const existing = new Set((await boss.getQueues()).map((q: QueueResult) => q.name));
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
        ...errorFields(err),
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
        ...errorFields(err),
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
  const startedAt = Date.now();
  const active = boss.getWipData().map((worker) => ({
    queue: worker.name,
    state: worker.state,
    count: worker.count,
    last_job_started_at: worker.lastJobStartedOn
      ? new Date(worker.lastJobStartedOn).toISOString()
      : null,
  }));
  logger.info({
    module: "queue",
    action: "boss.stop_begin",
    msg: "pg-boss graceful stop started",
    timeout_ms: timeoutMs,
    active,
  });
  try {
    await boss.stop({ graceful: true, timeout: timeoutMs, close: true });
  } catch (err) {
    logger.warn({
      module: "queue",
      action: "boss.stop_failed",
      msg: "pg-boss stop threw",
      ...errorFields(err),
    });
  }
  logger.info({
    module: "queue",
    action: "boss.stopped",
    msg: "pg-boss stopped",
    elapsed_ms: Date.now() - startedAt,
    active_before: active,
  });
}

export async function disposeBoss(boss: PgBoss): Promise<void> {
  try {
    await boss.stop({ graceful: false, close: true });
  } catch {}
}
