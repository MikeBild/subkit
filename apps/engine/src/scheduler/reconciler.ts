// Scheduler reconciler. At boot + every 60s it reads
// `workflows_schedules`, compares against the desired state, and syncs
// pg-boss schedules. Each schedule becomes a pg-boss scheduled send
// whose payload is an `execution.run` job envelope.
//
// Sub-minute schedules (expressed as `every:<seconds>`) are handled
// locally via setInterval because pg-boss' cron is minute-resolution.

import { CronExpressionParser } from "cron-parser";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { connectors, knowledgeSources, workflows, workflowsSchedules } from "../db/schema/index.ts";
import { createExecution } from "../execution/state.ts";
import { logger } from "../logging/logger.ts";
import { enqueueIngest, INGEST_DOCS_QUEUE } from "../queue/handlers/ingest-docs.ts";
import {
  enqueueKnowledgeIngest,
  INGEST_KNOWLEDGE_QUEUE,
} from "../queue/handlers/ingest-knowledge.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queue/queues.ts";
import { parseCronExpression, scheduleCron, unscheduleCron } from "./cron.ts";

export interface ReconcilerOptions {
  boss: PgBoss;
  db: Db;
  /** Reconcile cadence in ms. Defaults to 60_000. */
  intervalMs?: number;
}

interface DesiredState {
  // key -> definition
  cron: Map<string, { cron: string; payload: ExecutionRunJob; tz: string }>;
  every: Map<string, { seconds: number; payload: ExecutionRunJob }>;
}

function scheduleKeyForRow(row: { id: string }): string {
  return `wf-schedule:${row.id}`;
}

/**
 * Decide whether a cron schedule is "due" relative to `lastFiredAt`.
 *
 * Semantics: if there is no `lastFiredAt` we always say due. Otherwise
 * we ask the cron parser for the next firing time after `lastFiredAt`
 * and check whether `now` has passed it.
 *
 * The reconciler also accepts the engine's `every:N` shorthand so docs
 * auto-refresh tests can use the same expression syntax as the workflow
 * scheduler. For sub-minute cadences in production set
 * `auto_refresh_cron = "every:60"` etc.
 */
export function isCronDue(cron: string, lastFiredAt: Date | null, now: Date): boolean {
  const trimmed = cron.trim();
  if (trimmed.startsWith("every:")) {
    const seconds = Number.parseFloat(trimmed.slice("every:".length));
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    if (!lastFiredAt) return true;
    return now.getTime() - lastFiredAt.getTime() >= seconds * 1000;
  }
  try {
    if (!lastFiredAt) return true;
    const it = CronExpressionParser.parse(trimmed, {
      currentDate: lastFiredAt,
      strict: false,
    });
    const next = it.next().toDate();
    return now.getTime() >= next.getTime();
  } catch {
    return false;
  }
}

/**
 * Estimate the period between successive firings of a cron expression
 * in milliseconds. The reconciler uses this for the dedup gate: a
 * schedule is allowed to enqueue at most once per period regardless of
 * how long the engine was offline. This is intentionally a *lower
 * bound* — for irregular cron patterns (e.g. `0 9 * * MON`) the
 * smallest natural period dominates so the dedup never accidentally
 * over-skips.
 *
 * The implementation walks two consecutive `next()` results from the
 * parser and returns the gap. Returns `null` for invalid expressions
 * so the caller can fall back to "always allow" rather than crash.
 *
 * `every:N` returns N×1000.
 */
export function cronPeriodMs(cron: string): number | null {
  const trimmed = cron.trim();
  if (trimmed.startsWith("every:")) {
    const seconds = Number.parseFloat(trimmed.slice("every:".length));
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  }
  try {
    const it = CronExpressionParser.parse(trimmed, { strict: false });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    const diff = b - a;
    return diff > 0 ? diff : null;
  } catch {
    return null;
  }
}

export class SchedulerReconciler {
  private timer: NodeJS.Timeout | null = null;
  private everyTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Signatures of currently-installed desired state, keyed by schedule key. */
  private installed: Map<string, string> = new Map();
  private stopped = false;

  constructor(private readonly opts: ReconcilerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.reconcileOnce();
    const period = this.opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      this.reconcileOnce().catch((err) => {
        logger.error({
          module: "scheduler",
          action: "reconcile_failed",
          msg: "scheduler reconcile pass failed",
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, period);
    // Allow process to exit even if our interval is the only thing alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [key, t] of this.everyTimers) {
      clearInterval(t);
      this.everyTimers.delete(key);
    }
    this.installed.clear();
  }

  async reconcileOnce(): Promise<void> {
    if (this.stopped) return;
    // Docs auto-refresh runs on the same 60 s tick — every pass walks
    // the connectors with a non-null `auto_refresh_cron` and enqueues a
    // `connector.ingest-docs` job whenever the cron expression has
    // elapsed since the connector's `last_ingested_at`.
    await this.reconcileDocsAutoRefresh().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "docs_refresh_failed",
        msg: "scheduler docs auto-refresh pass failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await this.reconcileKnowledgeAutoRefresh().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "knowledge_refresh_failed",
        msg: "scheduler knowledge auto-refresh pass failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Workflow schedule fan-out is dedup'd via `last_enqueued_at`. The
    // reconciler itself walks every cron-mode schedule, asks
    // `isCronDue()` whether one full cron period has elapsed since the
    // last enqueue, and only THEN fires an execution.run job. A
    // 10-minute outage that brings a `* * * * *` schedule "10 minutes
    // behind" therefore produces ONE catch-up enqueue, not 10.
    await this.reconcileWorkflowSchedules().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "schedule_fanout_failed",
        msg: "scheduler workflow schedule fan-out pass failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const desired = await this.computeDesired();

    // Add/update cron schedules via pg-boss.
    for (const [key, def] of desired.cron) {
      const sig = `cron|${def.cron}|${JSON.stringify(def.payload)}|${def.tz}`;
      if (this.installed.get(key) === sig) continue;
      await scheduleCron({
        boss: this.opts.boss,
        name: key,
        cron: def.cron,
        payload: def.payload as unknown as object,
        tz: def.tz,
      });
      this.installed.set(key, sig);
      logger.info({
        module: "scheduler",
        action: "schedule.upserted",
        msg: "scheduled workflow cron",
        schedule_key: key,
        cron: def.cron,
      });
    }

    // Add/update every-mode schedules via setInterval.
    for (const [key, def] of desired.every) {
      const sig = `every|${def.seconds}|${JSON.stringify(def.payload)}`;
      if (this.installed.get(key) === sig) continue;
      // Clear prior timer if changed.
      const prior = this.everyTimers.get(key);
      if (prior) clearInterval(prior);
      const timer = setInterval(() => {
        void this.fireEvery(key, def.payload).catch((err) => {
          logger.error({
            module: "scheduler",
            action: "schedule.fire_failed",
            msg: "every-schedule enqueue failed",
            schedule_key: key,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, def.seconds * 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.everyTimers.set(key, timer);
      this.installed.set(key, sig);
      logger.info({
        module: "scheduler",
        action: "schedule.upserted",
        msg: "installed every-schedule",
        schedule_key: key,
        every_seconds: def.seconds,
      });
    }

    // Detect and remove schedules that are no longer desired.
    const desiredKeys = new Set([...desired.cron.keys(), ...desired.every.keys()]);
    for (const key of [...this.installed.keys()]) {
      if (desiredKeys.has(key)) continue;
      const timer = this.everyTimers.get(key);
      if (timer) {
        clearInterval(timer);
        this.everyTimers.delete(key);
      }
      await unscheduleCron(this.opts.boss, key);
      this.installed.delete(key);
      logger.info({
        module: "scheduler",
        action: "schedule.removed",
        msg: "removed schedule",
        schedule_key: key,
      });
    }
  }

  /**
   * Walk every connector with `auto_refresh_cron` set and enqueue a
   * `connector.ingest-docs` job when the cron expression has elapsed
   * since `last_ingested_at`. Connectors with `last_ingested_at IS NULL`
   * fire immediately so the first ingest after enabling the cron
   * happens without waiting for the cron's first natural tick.
   */
  async reconcileDocsAutoRefresh(): Promise<void> {
    const rows = await this.opts.db
      .select()
      .from(connectors)
      .where(and(isNotNull(connectors.auto_refresh_cron), isNull(connectors.deleted_at)));
    for (const row of rows) {
      const cron = row.auto_refresh_cron;
      if (!cron) continue;
      const due = isCronDue(cron, row.last_ingested_at ?? null, new Date());
      if (!due) continue;
      const cfg = (row.config as Record<string, unknown>) ?? {};
      const sourceType = typeof cfg.docs_source_type === "string" ? cfg.docs_source_type : null;
      const sourceUrl = typeof cfg.docs_source_url === "string" ? cfg.docs_source_url : null;
      if (!sourceType || !sourceUrl) {
        logger.debug({
          module: "scheduler",
          action: "docs_refresh_skip",
          msg: "connector auto_refresh_cron set but config.docs_source_* missing",
          connector_id: row.id,
        });
        continue;
      }
      try {
        await enqueueIngest(this.opts.boss, {
          tenant_id: row.tenant_id,
          connector_id: row.id,
          source_type: sourceType as "openapi",
          url: sourceUrl,
          actor_id: null,
        });
        // Stamp `last_ingested_at` immediately so we don't double-fire
        // before the worker handles the job. The worker will overwrite
        // it when the ingest actually completes.
        await this.opts.db
          .update(connectors)
          .set({ last_ingested_at: new Date() })
          .where(eq(connectors.id, row.id));
        logger.info({
          module: "scheduler",
          action: "docs_refresh_enqueued",
          msg: "auto-refresh enqueued ingest job",
          queue: INGEST_DOCS_QUEUE,
          connector_id: row.id,
          cron,
        });
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "docs_refresh_enqueue_failed",
          msg: "failed to enqueue auto-refresh ingest",
          connector_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Walk every active workflow schedule and enqueue an execution.run
   * job whenever the cron expression has elapsed since the schedule's
   * `last_enqueued_at`. This is the dedup gate that turns a multi-
   * minute outage into ONE catch-up enqueue instead of N — the next
   * time the reconciler runs after a 10-minute gap, `isCronDue` for a
   * `* * * * *` schedule says "due" exactly once, `last_enqueued_at`
   * is bumped, and the next pass 60 s later sees it as already-fired.
   *
   * Every-mode schedules stay on the `setInterval` path in
   * `reconcileOnce` because their natural cadence is sub-minute and
   * the interval timer already enforces the same dedup property.
   */
  async reconcileWorkflowSchedules(now: Date = new Date()): Promise<void> {
    const rows = await this.opts.db
      .select({
        schedule: workflowsSchedules,
        wf: workflows,
      })
      .from(workflowsSchedules)
      .innerJoin(workflows, eq(workflows.id, workflowsSchedules.workflow_id))
      .where(eq(workflowsSchedules.paused, false));

    for (const { schedule, wf } of rows) {
      const parsed = parseCronExpression(schedule.cron);
      if (!parsed.ok) continue;
      // Every-mode is handled by the local interval timer in
      // `reconcileOnce`; skip it here so we don't double-fire.
      if (parsed.mode === "every") continue;
      // Dedup gate: only enqueue if at least one full cron period has
      // elapsed since the last enqueue. A 10-minute outage that brings
      // a `* * * * *` schedule "10 minutes behind" therefore produces
      // ONE catch-up enqueue, not 10.
      const period = cronPeriodMs(schedule.cron);
      const last = schedule.last_enqueued_at ?? null;
      if (last && period !== null) {
        if (now.getTime() - last.getTime() < period) continue;
      } else if (last && period === null) {
        // Invalid period — be conservative and skip rather than fire
        // an unbounded number of catch-up enqueues.
        continue;
      }
      try {
        const payload: ExecutionRunJob = {
          tenant_id: wf.tenant_id,
          workflow_id: wf.id,
          input: schedule.input ?? null,
          request_source: "scheduler",
        };
        // Stamp `last_enqueued_at = now` BEFORE the enqueue so a crash
        // mid-fire cannot replay the schedule on next boot. The
        // RETURNING-empty case (parallel reconciler beat us) is not
        // possible today since the WHERE has no version guard, but the
        // pattern keeps the door open for one if a second engine
        // instance is ever introduced.
        const stamped = await this.opts.db
          .update(workflowsSchedules)
          .set({ last_enqueued_at: now })
          .where(eq(workflowsSchedules.id, schedule.id))
          .returning({ id: workflowsSchedules.id });
        if (stamped.length === 0) continue;
        await this.fireWorkflowSchedule(scheduleKeyForRow(schedule), payload);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "schedule.fanout_failed",
          msg: "workflow schedule fan-out enqueue failed",
          schedule_id: schedule.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async fireWorkflowSchedule(key: string, payload: ExecutionRunJob): Promise<void> {
    const workflow_version_id = await this.resolveWorkflowVersion(payload.workflow_id);
    const execution_id = await createExecution(this.opts.db, {
      tenant_id: payload.tenant_id,
      workflow_id: payload.workflow_id,
      workflow_version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "scheduler",
      parent_execution_id: null,
    });
    const job: ExecutionRunJob = { ...payload, execution_id, request_source: "scheduler" };
    await this.opts.boss.send(EXECUTION_RUN_QUEUE, job);
    logger.info({
      module: "scheduler",
      action: "schedule.fired",
      msg: "cron-schedule enqueued execution.run",
      schedule_key: key,
      execution_id,
    });
  }

  private async fireEvery(key: string, payload: ExecutionRunJob): Promise<void> {
    // Materialize the execution row here so the API can observe a
    // `queued` row immediately, mirroring the HTTP path.
    const workflow_version_id = await this.resolveWorkflowVersion(payload.workflow_id);
    const execution_id = await createExecution(this.opts.db, {
      tenant_id: payload.tenant_id,
      workflow_id: payload.workflow_id,
      workflow_version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "scheduler",
      parent_execution_id: null,
    });
    const job: ExecutionRunJob = { ...payload, execution_id, request_source: "scheduler" };
    await this.opts.boss.send(EXECUTION_RUN_QUEUE, job);
    logger.info({
      module: "scheduler",
      action: "schedule.fired",
      msg: "every-schedule enqueued execution.run",
      schedule_key: key,
      execution_id,
    });
  }

  private async resolveWorkflowVersion(workflow_id: string): Promise<string> {
    const rows = await this.opts.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflow_id))
      .limit(1);
    const versionId = rows[0]?.current_version_id;
    if (!versionId) {
      throw new Error(`workflow ${workflow_id} has no current_version_id`);
    }
    return versionId;
  }

  private async computeDesired(): Promise<DesiredState> {
    const rows = await this.opts.db
      .select({
        schedule: workflowsSchedules,
        wf: workflows,
      })
      .from(workflowsSchedules)
      .innerJoin(workflows, eq(workflows.id, workflowsSchedules.workflow_id))
      .where(eq(workflowsSchedules.paused, false));

    const cron: DesiredState["cron"] = new Map();
    const every: DesiredState["every"] = new Map();
    for (const { schedule, wf } of rows) {
      const parsed = parseCronExpression(schedule.cron);
      if (!parsed.ok) {
        logger.warn({
          module: "scheduler",
          action: "schedule.invalid_cron",
          msg: "skipping schedule with invalid cron",
          schedule_id: schedule.id,
          cron: schedule.cron,
          reason: parsed.reason,
        });
        continue;
      }
      const key = scheduleKeyForRow(schedule);
      const payload: ExecutionRunJob = {
        tenant_id: wf.tenant_id,
        workflow_id: wf.id,
        input: schedule.input ?? null,
        request_source: "scheduler",
      };
      if (parsed.mode === "cron") {
        cron.set(key, { cron: schedule.cron, payload, tz: schedule.timezone });
      } else if (parsed.mode === "every" && parsed.everySeconds !== undefined) {
        every.set(key, { seconds: parsed.everySeconds, payload });
      }
    }
    return { cron, every };
  }

  /**
   * Knowledge Sources auto-refresh. Walks knowledge sources with
   * `refresh_strategy = 'scheduled'` and enqueues a re-ingest job
   * when the cron expression fires.
   *
   * Note: Only URL-based sources can be auto-refreshed (the content
   * is re-fetched). File-upload sources require a manual re-upload.
   */
  async reconcileKnowledgeAutoRefresh(): Promise<void> {
    const rows = await this.opts.db
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.refresh_strategy, "scheduled"),
          eq(knowledgeSources.status, "active"),
          isNull(knowledgeSources.deleted_at),
          isNotNull(knowledgeSources.refresh_cron),
        ),
      );
    for (const row of rows) {
      const cron = row.refresh_cron;
      if (!cron) continue;
      const due = isCronDue(cron, row.last_refreshed_at ?? null, new Date());
      if (!due) continue;
      try {
        await enqueueKnowledgeIngest(this.opts.boss, {
          tenant_id: row.tenant_id,
          knowledge_source_id: row.id,
          filename: row.source_uri,
          content: "", // file-upload sources cannot be auto-refreshed
          actor_id: null,
        });
        await this.opts.db
          .update(knowledgeSources)
          .set({ last_refreshed_at: new Date() })
          .where(eq(knowledgeSources.id, row.id));
        logger.info({
          module: "scheduler",
          action: "knowledge_refresh_enqueued",
          msg: "knowledge auto-refresh enqueued ingest job",
          queue: INGEST_KNOWLEDGE_QUEUE,
          knowledge_source_id: row.id,
          cron,
        });
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "knowledge_refresh_enqueue_failed",
          msg: "failed to enqueue knowledge auto-refresh ingest",
          knowledge_source_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
