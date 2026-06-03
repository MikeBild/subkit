// Scheduler reconciler. At boot + every 60s it reads
// `workflows_schedules`, compares against the desired state, and syncs
// pg-boss schedules. Each schedule becomes a pg-boss scheduled send
// whose payload is an `execution.run` job envelope.
//
// Sub-minute schedules (expressed as `every:<seconds>`) are handled
// locally via setInterval because pg-boss' cron is minute-resolution.

import { CronExpressionParser } from "cron-parser";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import {
  connectors,
  knowledgeSources,
  tenants,
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { createExecution } from "../execution/state.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { enqueueIngest, INGEST_DOCS_QUEUE } from "../queue/handlers/ingest-docs.ts";
import {
  enqueueKnowledgeIngest,
  INGEST_KNOWLEDGE_QUEUE,
} from "../queue/handlers/ingest-knowledge.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queue/queues.ts";
import { runChatDedupCleanup } from "./chat-dedup-cleanup-runner.ts";
import { parseCronExpression } from "./cron.ts";
import { runFilesCleanup } from "./files-cleanup-runner.ts";
import { runMcpOAuthCleanup } from "./mcp-oauth-cleanup-runner.ts";
import { runProactiveDriftScanForTenant } from "./proactive-drift-scan-runner.ts";

/** Fixed cadence for proactive drift scans (per scope decision). One
 *  hour balances early-detection value against the cost of repeated
 *  LLM repair calls when drift signals are emitted. */
const PROACTIVE_DRIFT_SCAN_CADENCE_MS = 60 * 60 * 1000;

/** Fixed cadence for the unified-files cleanup cron. The sweeps are
 *  idempotent and bounded by a 7-day soft-delete grace, so an hour
 *  balances reaping latency against cron cost. Multi-instance
 *  deployments may run the sweep twice per cadence on rare
 *  clock-overlaps; that's safe — DELETE / UPDATE are filtered by
 *  `now() - interval ...` so the second instance is a no-op. */
const FILES_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

/** Fixed cadence for the MCP OAuth retention sweep. Hour resolution
 *  matches the files-cleanup cadence — the sweeps are filtered by
 *  `now() - interval ...` so a second concurrent instance is a no-op. */
const MCP_OAUTH_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

/** Fixed cadence for the chat_events_seen retention sweep. Slack
 *  retries arrive within minutes, so a 24h grace is plenty; sweeping
 *  hourly keeps growth bounded and the cadence in line with the other
 *  retention sweeps. */
const CHAT_DEDUP_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

export interface ReconcilerOptions {
  boss: PgBoss;
  db: Db;
  /** Reconcile cadence in ms. Defaults to 60_000. */
  intervalMs?: number;
}

/** Desired sub-minute (`every:N`) schedules, keyed by schedule key.
 *  Cron-mode schedules are not part of desired state — they are fired
 *  directly by `reconcileWorkflowSchedules` on each 60s pass. */
type EveryDesiredState = Map<string, { seconds: number; payload: ExecutionRunJob }>;

function scheduleKeyForRow(row: { id: string }): string {
  // Internal, process-local identifier for a schedule — the key of the
  // every-timer map and the `schedule_key` field on fired-schedule logs.
  // Not a queue name (the engine no longer schedules into pg-boss).
  return `wf-schedule.${row.id}`;
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
 *
 * `tz` (optional, IANA timezone name) is forwarded to the cron parser so
 * a `0 9 * * *` schedule with `tz: "Europe/Berlin"` resolves to 09:00
 * Berlin local — i.e. 08:00 UTC in winter, 07:00 UTC in summer. Both
 * the comparison `now` (a real instant) and the cron expansion stay
 * consistent because the parser internally projects `currentDate` into
 * the requested zone before walking the cron fields.
 */
export function isCronDue(cron: string, lastFiredAt: Date | null, now: Date, tz?: string): boolean {
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
      ...(tz ? { tz } : {}),
    });
    const next = it.next().toDate();
    return now.getTime() >= next.getTime();
  } catch {
    return false;
  }
}

/**
 * Compute the calendar date in a target timezone for a real instant.
 * Returns `YYYY-MM-DD` so the reconciler can match against the
 * `skip_dates` array authored on the trigger.
 *
 * Implementation uses `Intl.DateTimeFormat` because Node's stdlib
 * `Date` only carries UTC + system-local zones. Invalid `tz` falls
 * back to UTC so a typo never crashes the reconciler — the schedule
 * still fires, just in the wrong zone. The cron-parser path validates
 * the same `tz` and surfaces the typo through the schedule fan-out.
 */
export function localDateInTz(now: Date, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // en-CA emits YYYY-MM-DD natively, so no part shuffling required.
    return fmt.format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
}

/**
 * Compute the local-tz weekday (0=Sun..6=Sat) for a real instant. Used
 * by the `business_days_only` gate so weekends in the schedule's
 * timezone — not the engine's host zone — are recognised.
 */
export function localWeekdayInTz(now: Date, tz: string): number {
  try {
    // `weekday: short` is locale-stable and easy to map. The English
    // long form would also work but the short form is faster to scan.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
    });
    const day = fmt.format(now);
    const map: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return map[day] ?? now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

/**
 * Calendar-gate decision used by the workflow-schedule fan-out. Encodes
 * the issue-#47 contract:
 *   - `business_days_only: true` skips Sat (6) + Sun (0) in `tz`.
 *   - `skip_dates` (YYYY-MM-DD) skips the explicit list in `tz`.
 *
 * Returns the reason string when the firing should be skipped, `null`
 * when it should proceed. The caller logs the reason via the
 * `schedule.skipped` action and leaves `last_enqueued_at` untouched so
 * the next cron tick gets a fresh evaluation.
 */
export function calendarGateSkipReason(
  now: Date,
  tz: string,
  gates: { business_days_only?: boolean; skip_dates?: string[] },
): "weekend" | "skip_date" | null {
  if (gates.business_days_only === true) {
    const weekday = localWeekdayInTz(now, tz);
    if (weekday === 0 || weekday === 6) return "weekend";
  }
  if (gates.skip_dates && gates.skip_dates.length > 0) {
    const localDate = localDateInTz(now, tz);
    if (gates.skip_dates.includes(localDate)) return "skip_date";
  }
  return null;
}

/**
 * The reverse-bind helper (`bindFromWorkflow`) stashes the calendar
 * gates inside the schedule's `input` jsonb so we don't need a schema
 * migration for two boolean knobs. The reconciler peels them off
 * before passing the row's `input` down to the execution as the
 * workflow's request payload — otherwise the workflow would observe
 * `business_days_only` / `skip_dates` keys that aren't part of its
 * input contract.
 */
export function readCalendarGates(input: unknown): {
  business_days_only?: boolean;
  skip_dates?: string[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const obj = input as Record<string, unknown>;
  const out: { business_days_only?: boolean; skip_dates?: string[] } = {};
  if (typeof obj.business_days_only === "boolean") {
    out.business_days_only = obj.business_days_only;
  }
  if (Array.isArray(obj.skip_dates)) {
    out.skip_dates = obj.skip_dates.filter((d): d is string => typeof d === "string");
  }
  return out;
}

/**
 * Strip the calendar-gate keys back out of the `input` jsonb before
 * the value flows to the execution as the workflow's request payload.
 * Schedules created via the legacy CRUD API (no trigger reverse-bind)
 * pass through unchanged because the gates simply aren't present.
 */
export function stripCalendarGates(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? null;
  const obj = input as Record<string, unknown>;
  if (!("business_days_only" in obj) && !("skip_dates" in obj)) return input;
  const { business_days_only: _bd, skip_dates: _sd, ...rest } = obj;
  return Object.keys(rest).length === 0 ? null : rest;
}

export class SchedulerReconciler {
  private timer: NodeJS.Timeout | null = null;
  private everyTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Signatures of currently-installed desired state, keyed by schedule key. */
  private installed: Map<string, string> = new Map();
  private stopped = false;
  /** Last instant the files-cleanup cron ran. Used as an in-process
   *  throttle so the 60 s reconciler tick only fires the cleanup once
   *  per `FILES_CLEANUP_CADENCE_MS`. Multi-instance overlap is safe —
   *  see the comment on the cadence constant. */
  private lastFilesCleanupAt: Date | null = null;

  /** Last instant the MCP OAuth cleanup cron ran. Same in-process
   *  throttle as `lastFilesCleanupAt`. */
  private lastMcpOAuthCleanupAt: Date | null = null;

  /** Last instant the chat_events_seen retention sweep ran. */
  private lastChatDedupCleanupAt: Date | null = null;

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
          ...errorFields(err),
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
        ...errorFields(err),
      });
    });
    await this.reconcileKnowledgeAutoRefresh().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "knowledge_refresh_failed",
        msg: "scheduler knowledge auto-refresh pass failed",
        ...errorFields(err),
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
        ...errorFields(err),
      });
    });
    // Proactive self-healing drift scan. Per-tenant CAS-stamp on
    // `tenants.last_proactive_scan_at` gives multi-instance deployments
    // exactly-once firing per cadence; the scan itself runs `scanForDrift`
    // followed by `processDriftSignal({ allowAutoApply: false })` per
    // signal so every Patch Candidate produced this way is parked for
    // operator review regardless of policy/classification gates.
    await this.reconcileProactiveDriftScans().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "drift_scan_failed",
        msg: "scheduler proactive drift scan pass failed",
        ...errorFields(err),
      });
    });
    // Unified-files cleanup cron. Hour-throttled in-process;
    // multi-instance overlap is safe — see the cadence
    // constant comment. The runner walks three sweeps (pending
    // orphans, unlinked TTL, LLM provider expiry); errors inside the
    // sweeps are caught per-sweep so a failure does not abort the rest
    // of the reconciler tick.
    await this.reconcileFilesCleanup().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "files_cleanup_failed",
        msg: "scheduler files cleanup pass failed",
        ...errorFields(err),
      });
    });
    // MCP OAuth retention sweep. Hour-throttled in-process; errors
    // inside the sweeps are caught per-sweep so a failure does not
    // abort the rest of the reconciler tick.
    await this.reconcileMcpOAuthCleanup().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "mcp_oauth_cleanup_failed",
        msg: "scheduler MCP OAuth cleanup pass failed",
        ...errorFields(err),
      });
    });
    // chat_events_seen retention sweep. Same hour-throttle pattern;
    // bounds the replay-dedup table as inbound Slack volume grows.
    await this.reconcileChatDedupCleanup().catch((err) => {
      logger.error({
        module: "scheduler",
        action: "chat_dedup_cleanup_failed",
        msg: "scheduler chat-dedup cleanup pass failed",
        ...errorFields(err),
      });
    });
    const desired = await this.computeDesired();

    // Install sub-minute (`every:N`) schedules as local interval timers.
    // Cron-mode schedules are NOT installed here — they fire directly
    // from `reconcileWorkflowSchedules` on each pass. There is no
    // pg-boss-native cron path: a `wf-schedule.*` queue has no worker.
    for (const [key, def] of desired) {
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
            ...errorFields(err),
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

    // Detect and remove every-schedules that are no longer desired.
    const desiredKeys = new Set(desired.keys());
    for (const key of [...this.installed.keys()]) {
      if (desiredKeys.has(key)) continue;
      const timer = this.everyTimers.get(key);
      if (timer) {
        clearInterval(timer);
        this.everyTimers.delete(key);
      }
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
    await instrument({
      module: "scheduler",
      action: "docs_auto_refresh.run",
      fn: () => this.reconcileDocsAutoRefreshPass(),
    });
  }

  private async reconcileDocsAutoRefreshPass(): Promise<void> {
    // tenant-filter:exempt — cron scheduler sweeps every tenant; row carries tenant_id forward
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
          ...errorFields(err),
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
    await instrument({
      module: "scheduler",
      action: "workflow_schedules.run",
      fn: () => this.reconcileWorkflowSchedulesPass(now),
    });
  }

  private async reconcileWorkflowSchedulesPass(now: Date): Promise<void> {
    // tenant-filter:exempt — cron scheduler sweeps every tenant; row carries tenant_id forward
    const rows = await this.opts.db
      .select({
        schedule: workflowsSchedules,
        wf: workflows,
      })
      .from(workflowsSchedules)
      .innerJoin(workflows, eq(workflows.id, workflowsSchedules.workflow_id))
      .where(eq(workflowsSchedules.paused, false));

    for (const { schedule, wf } of rows) {
      // Tenant-isolation guard: the schedule row must claim the same tenant
      // as its joined workflow. A mismatch indicates a handcrafted or
      // corrupted row; skipping it prevents cross-tenant execution pollution.
      if (schedule.tenant_id !== wf.tenant_id) {
        logger.warn({
          module: "scheduler",
          action: "schedule.tenant_mismatch",
          msg: "schedule tenant_id does not match workflow tenant_id — skipping",
          schedule_id: schedule.id,
          schedule_tenant_id: schedule.tenant_id,
          workflow_id: wf.id,
          workflow_tenant_id: wf.tenant_id,
        });
        continue;
      }
      const parsed = parseCronExpression(schedule.cron);
      if (!parsed.ok) continue;
      // Every-mode is handled by the local interval timer in
      // `reconcileOnce`; skip it here so we don't double-fire.
      if (parsed.mode === "every") continue;
      // Time-of-day-aware dedup gate: enqueue only once the cron's next
      // occurrence after the last enqueue has actually passed. So
      // `0 19 * * *` fires at ~19:00 local, not "24h after boot"; and a
      // multi-minute outage that brings a `* * * * *` schedule behind
      // still produces exactly ONE catch-up enqueue. The CAS-stamp on
      // `last_enqueued_at` below keeps it exactly-once across instances.
      const tz = schedule.timezone || "UTC";
      const last = schedule.last_enqueued_at ?? null;
      if (!isCronDue(schedule.cron, last, now, tz)) continue;
      // Calendar gates. The trigger's `business_days_only`
      // and `skip_dates` round-trip through the schedule's `input`
      // jsonb column (see `bindFromWorkflow`). We intentionally do
      // NOT advance `last_enqueued_at` on a calendar-skip — the next
      // cron tick re-evaluates from the same `last_enqueued_at`, so
      // a Friday firing that gets skip_date'd still fires on Monday
      // when the calendar reopens. Bumping `last_enqueued_at` here
      // would shift the dedup window forward and silently drop the
      // recovery firing.
      const gates = readCalendarGates(schedule.input);
      const skipReason = calendarGateSkipReason(now, tz, gates);
      if (skipReason !== null) {
        logger.info({
          module: "scheduler",
          action: "schedule.skipped",
          msg: "calendar gate suppressed schedule firing",
          schedule_id: schedule.id,
          workflow_id: wf.id,
          tz,
          reason: skipReason,
          local_date: localDateInTz(now, tz),
        });
        continue;
      }
      try {
        const payload: ExecutionRunJob = {
          tenant_id: wf.tenant_id,
          workflow_id: wf.id,
          input: stripCalendarGates(schedule.input),
          request_source: "scheduler",
        };
        // Stamp `last_enqueued_at = now` BEFORE the enqueue so a crash
        // mid-fire cannot replay the schedule on next boot.
        //
        // Compare-and-set on `last_enqueued_at`: only update if the
        // value is still the one we just read (or was NULL). If two
        // reconcilers run concurrently, exactly one wins this UPDATE
        // and the other's RETURNING comes back empty — the loser
        // skips fireWorkflowSchedule and the schedule fires once.
        const priorWhere =
          last === null
            ? isNull(workflowsSchedules.last_enqueued_at)
            : eq(workflowsSchedules.last_enqueued_at, last);
        const stamped = await this.opts.db
          .update(workflowsSchedules)
          .set({ last_enqueued_at: now })
          .where(and(eq(workflowsSchedules.id, schedule.id), priorWhere))
          .returning({ id: workflowsSchedules.id });
        if (stamped.length === 0) continue;
        await this.fireWorkflowSchedule(scheduleKeyForRow(schedule), payload, {
          tenant_id: wf.tenant_id,
          schedule_id: schedule.id,
          tz,
        });
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "schedule.fanout_failed",
          msg: "workflow schedule fan-out enqueue failed",
          schedule_id: schedule.id,
          ...errorFields(err),
        });
      }
    }
  }

  /**
   * Proactive self-healing drift scan. Each live tenant whose
   * `last_proactive_scan_at` is NULL or older than the cadence wins
   * a CAS-stamp and is scanned exactly once per cadence.
   *
   * Per fired tenant:
   *   1) Insert a `self_healing_scans` row with status='running' and
   *      source='scheduler'. This row is the durable record of the
   *      scan attempt; the SELF_HEALING_SCAN_TRIGGERED audit row
   *      points at its id.
   *   2) Run `scanForDrift({ tenant_id })` (pure DB read).
   *   3) For each signal call `processDriftSignal(..., {
   *      allowAutoApply: false })` so the Patch Candidate is always
   *      proposed, never silently applied — operator review remains
   *      the sole apply path on the proactive branch.
   *   4) Update the scan row with counters + duration_ms + status,
   *      and emit the SELF_HEALING_SCAN_COMPLETED audit row.
   *
   * Failures inside steps 2-3 are caught per-tenant: the scan row
   * lands in status='failed' with the error text, the audit row is
   * still emitted, and the next reconciler tick keeps sweeping the
   * other tenants.
   */
  async reconcileProactiveDriftScans(now: Date = new Date()): Promise<void> {
    // tenant-filter:exempt — proactive drift scan sweeps every tenant; row carries tenant_id forward
    const cadenceCutoff = new Date(now.getTime() - PROACTIVE_DRIFT_SCAN_CADENCE_MS);
    const dueRows = await this.opts.db
      .select({
        id: tenants.id,
        last_proactive_scan_at: tenants.last_proactive_scan_at,
      })
      .from(tenants)
      .where(
        and(
          isNull(tenants.deleted_at),
          or(
            isNull(tenants.last_proactive_scan_at),
            lt(tenants.last_proactive_scan_at, cadenceCutoff),
          ),
        ),
      );

    for (const tenant of dueRows) {
      // Compare-and-set on `last_proactive_scan_at`: a concurrent
      // reconciler in another engine instance racing for the same
      // tenant only sees one successful UPDATE; the loser's
      // RETURNING comes back empty and skips the scan.
      const priorWhere =
        tenant.last_proactive_scan_at === null
          ? isNull(tenants.last_proactive_scan_at)
          : eq(tenants.last_proactive_scan_at, tenant.last_proactive_scan_at);
      const stamped = await this.opts.db
        .update(tenants)
        .set({ last_proactive_scan_at: now })
        .where(and(eq(tenants.id, tenant.id), priorWhere))
        .returning({ id: tenants.id });
      if (stamped.length === 0) continue;

      await runProactiveDriftScanForTenant(tenant.id, now, this.opts.db);
    }
  }

  /**
   * Throttle the files-cleanup cron to one fire per
   * `FILES_CLEANUP_CADENCE_MS`. The reconciler ticks every 60 s; without
   * this guard the cleanup would walk every row on every tick. The
   * throttle is in-process — multiple engine instances may each run the
   * sweep within the cadence window, but the sweeps are filtered by
   * `now() - interval ...` so the second instance is a no-op rather
   * than a correctness hazard.
   */
  async reconcileFilesCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastFilesCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastFilesCleanupAt.getTime();
      if (elapsed < FILES_CLEANUP_CADENCE_MS) return;
    }
    this.lastFilesCleanupAt = now;
    await runFilesCleanup(now, this.opts.db);
  }

  /**
   * Throttle the MCP OAuth retention sweep to one fire per
   * `MCP_OAUTH_CLEANUP_CADENCE_MS`. Same semantics as
   * `reconcileFilesCleanup` — the sweeps are filtered by
   * `now() - interval ...` so a concurrent instance is a no-op.
   */
  async reconcileMcpOAuthCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastMcpOAuthCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastMcpOAuthCleanupAt.getTime();
      if (elapsed < MCP_OAUTH_CLEANUP_CADENCE_MS) return;
    }
    this.lastMcpOAuthCleanupAt = now;
    await runMcpOAuthCleanup(now, this.opts.db);
  }

  /**
   * Throttle the chat_events_seen retention sweep. Same semantics as
   * `reconcileMcpOAuthCleanup` — multi-instance overlap is safe
   * because the sweep filters by `now() - interval '24h'`.
   */
  async reconcileChatDedupCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastChatDedupCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastChatDedupCleanupAt.getTime();
      if (elapsed < CHAT_DEDUP_CLEANUP_CADENCE_MS) return;
    }
    this.lastChatDedupCleanupAt = now;
    await runChatDedupCleanup(now, this.opts.db);
  }

  private async fireWorkflowSchedule(
    key: string,
    payload: ExecutionRunJob,
    audit: { tenant_id: string; schedule_id: string; tz: string },
  ): Promise<void> {
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
    // Reverse-bind audit per AGENTS.md: every schedule firing gets an
    // immutable trail row pointing at the workflow + execution it
    // produced. The webhook variant emits the same shape via
    // `WEBHOOK_TRIGGER_FIRED`; the symmetry matters when an operator
    // audits "what woke up this workflow at 3am". We pass the
    // reconciler's `db` as the executor so the audit row lands in the
    // same database the rest of the scheduler writes to (tests use
    // ephemeral databases that the global `getDb()` doesn't know about).
    await auditAwait(
      {
        tenant_id: audit.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SCHEDULE_TRIGGER_FIRED,
        resource_type: "workflow_schedule",
        resource_id: audit.schedule_id,
        result: "success",
        metadata: {
          workflow_id: payload.workflow_id,
          execution_id,
          tz: audit.tz,
        },
      },
      this.opts.db,
    );
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
    // tenant-filter:exempt — cron scheduler sweeps every tenant; row carries tenant_id forward
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

  private async computeDesired(): Promise<EveryDesiredState> {
    // tenant-filter:exempt — cron scheduler sweeps every tenant; row carries tenant_id forward
    const rows = await this.opts.db
      .select({
        schedule: workflowsSchedules,
        wf: workflows,
      })
      .from(workflowsSchedules)
      .innerJoin(workflows, eq(workflows.id, workflowsSchedules.workflow_id))
      .where(eq(workflowsSchedules.paused, false));

    const every: EveryDesiredState = new Map();
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
        // Strip calendar-gate keys before they ride down to the
        // execution payload — the workflow's input contract should
        // never see `business_days_only` / `skip_dates`.
        input: stripCalendarGates(schedule.input ?? null),
        request_source: "scheduler",
      };
      // Cron-mode schedules are fired directly by
      // `reconcileWorkflowSchedules`; only `every:N` schedules need a
      // local interval timer installed.
      if (parsed.mode === "every" && parsed.everySeconds !== undefined) {
        every.set(key, { seconds: parsed.everySeconds, payload });
      }
    }
    return every;
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
    await instrument({
      module: "scheduler",
      action: "knowledge_auto_refresh.run",
      fn: () => this.reconcileKnowledgeAutoRefreshPass(),
    });
  }

  private async reconcileKnowledgeAutoRefreshPass(): Promise<void> {
    // tenant-filter:exempt — cron scheduler sweeps every tenant; row carries tenant_id forward
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
          ...errorFields(err),
        });
      }
    }
  }
}
