// Scheduler reconciler. At boot + every 60s it reads
// `workflows_schedules`, compares against the desired state, and syncs
// pg-boss schedules. Each schedule becomes a pg-boss scheduled send
// whose payload is an `execution.run` job envelope.
//
// Sub-minute schedules (expressed as `every:<seconds>`) are handled
// locally via setInterval because pg-boss' cron is minute-resolution.

import { CronExpressionParser } from "cron-parser";
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { probeAllSelfDescriptionLinks } from "../connectors/discovery/self-description-probe.ts";
import { runDiscoveryCached } from "../connectors/discovery/service.ts";
import { attachConnectorSelfDescriptionLinks } from "../connectors/service.ts";
import { refreshDueConnections } from "../credentials/index.ts";
import type { Db } from "../db/client.ts";
import {
  connectors,
  knowledgeSources,
  tenants,
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { backfillEmbeddings } from "../embeddings/backfill.ts";
import { createExecution } from "../execution/state.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { enqueueApprovalElicitationResume } from "../queue/approval-resume.ts";
import { enqueueIngest, INGEST_DOCS_QUEUE } from "../queue/handlers/ingest-docs.ts";
import {
  enqueueKnowledgeIngest,
  INGEST_KNOWLEDGE_QUEUE,
} from "../queue/handlers/ingest-knowledge.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queue/queues.ts";
import { runChatDedupCleanup } from "./chat-dedup-cleanup-runner.ts";
import {
  runConnectorReauthScanForTenant,
  runOAuth2RefreshKeepAliveForTenant,
} from "./connector-reauth-scan-runner.ts";
import { runConversationTitleSweepSafely } from "./conversation-title-runner.ts";
import { parseCronExpression } from "./cron.ts";
import { runElicitationExpiry } from "./elicitation-expiry-runner.ts";
import { runEndpointContractScanForTenant } from "./endpoint-contract-scan-runner.ts";
import { runFilesCleanup } from "./files-cleanup-runner.ts";
import { runMcpOAuthCleanup } from "./mcp-oauth-cleanup-runner.ts";
import { runNotificationInboxRetention } from "./notification-inbox-retention-runner.ts";
import { runProactiveDriftScanForTenant } from "./proactive-drift-scan-runner.ts";
import { runSkillCandidateAnalysisSweep } from "./skill-candidate-analyze-runner.ts";
import { runToolApprovalsCleanup } from "./tool-approvals-cleanup-runner.ts";

/** Fixed cadence for proactive drift scans (per scope decision). One
 *  hour balances early-detection value against the cost of repeated
 *  LLM repair calls when drift signals are emitted. */
const PROACTIVE_DRIFT_SCAN_CADENCE_MS = 60 * 60 * 1000;

/** Fixed cadence for the proactive connector re-auth health scan. One
 *  hour is a reasonable early-detection window for stale credentials
 *  without hammering vendor rate limits. The CAS-stamp claim pattern
 *  ensures exactly-once firing per cadence across multi-instance
 *  deployments. */
const CONNECTOR_REAUTH_SCAN_CADENCE_MS = 60 * 60 * 1000;
// Endpoint-contract probes hit external vendors with real GETs — a 6h
// cadence catches a removal/deprecation within the day while staying
// polite (the migration windows these probes exist to exploit are weeks).
const ENDPOINT_CONTRACT_SCAN_CADENCE_MS = 6 * 60 * 60 * 1000;

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
/** Outbound connections renew themselves within five minutes of expiry; a
 *  one-minute cadence leaves at least four sweeps inside that window. */
const CONNECTION_REFRESH_CADENCE_MS = 60 * 1000;

/** Fixed cadence for the chat_events_seen retention sweep. Slack
 *  retries arrive within minutes, so a 24h grace is plenty; sweeping
 *  hourly keeps growth bounded and the cadence in line with the other
 *  retention sweeps. */
const CHAT_DEDUP_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

/** Cadence for naming dormant conversations. Five minutes, like the other
 *  backfill sweep: the work is bounded per tick and only matters to a person
 *  scrolling the list, so it may take hours to walk an old estate. Two
 *  instances doing it at once cost duplicate model calls at worst — the write
 *  is guarded by `title_locked = false` and the second one finds the row
 *  already renamed and skips it. */
const CONVERSATION_TITLE_SWEEP_CADENCE_MS = 5 * 60 * 1000;

/** Fixed cadence for the cli_notification_inbox retention sweep. Hourly,
 *  like the other retention sweeps; the sweep filters by
 *  `now() - notifications.inbox.retention_days` so a concurrent instance
 *  is a no-op. */
const NOTIFICATION_INBOX_RETENTION_CADENCE_MS = 60 * 60 * 1000;

/** Fixed cadence for the `tool_approvals` retention sweep. Hourly, like the
 *  other retention sweeps: the rows are bounded by a 24-hour TTL plus a
 *  1-day retention window, and the sweep filters by `now() - interval ...`
 *  so a concurrent instance is a no-op. */
const TOOL_APPROVALS_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

/** Fixed cadence for the approval-backed elicitation expiry sweep. Five
 *  minutes — the approvals it reconciles die on a 24-hour TTL, so a
 *  stranded `awaiting_input` conversation is reactivated within roughly one
 *  TTL plus one cadence. Multi-instance overlap is a no-op: the sweep's
 *  writes ride CAS predicates (`status = 'pending'`,
 *  `status = 'awaiting_input'`), so a second instance loses every race. */
const ELICITATION_EXPIRY_CADENCE_MS = 5 * 60 * 1000;

/** Cadence for the embedding backfill sweep — populates chunk + conversation
 *  topic embeddings out-of-band (ingest stays fast). Five minutes so new
 *  knowledge/docs/conversations become semantically searchable soon after
 *  creation without burdening the ingest path. Each tick is bounded
 *  (maxBatches) so a large backlog drains over several ticks; the sweep is
 *  idempotent (WHERE embedding IS NULL) so multi-instance overlap is safe. */
const EMBEDDING_BACKFILL_CADENCE_MS = 5 * 60 * 1000;

/** Cadence + batch cap for the connector self-description enrichment sweep.
 *  Every HTTP/GraphQL connector with a base_url has its discovery cache +
 *  self-description LINKS refreshed at most once per cadence — connectors get
 *  richer the more they exist, which lifts authoring quality. The per-tick
 *  batch is capped so a large estate drains over several cadence cycles
 *  (oldest-first, enrichment-needed-first) instead of fanning out N bounded
 *  discovery HTTP calls at once. In-process throttle (like the cleanup
 *  sweeps) — multi-instance overlap is safe because runDiscoveryCached is
 *  idempotent: it only rewrites the discovery cache + the connector's
 *  self_description metadata, never config/auth. */
const CONNECTOR_SELF_DESCRIPTION_CADENCE_MS = 24 * 60 * 60 * 1000;
const CONNECTOR_SELF_DESCRIPTION_BATCH = 10;
/** Per-connector bound for one discovery refresh. runDiscoveryCached has its
 *  own internal 30s timeout; this tighter abort caps the sweep's own wait so a
 *  single slow upstream cannot stall the whole batch. */
const CONNECTOR_SELF_DESCRIPTION_DISCOVERY_TIMEOUT_MS = 8_000;

export interface ReconcilerOptions {
  boss: PgBoss;
  db: Db;
  /** Reconcile cadence in ms. Defaults to 60_000. */
  intervalMs?: number;
  /** Discovery runner seam. Defaults to runDiscoveryCached; overridable in
   *  tests so the self-description enrichment sweep's selection + non-fatal
   *  per-connector behavior can be asserted without real outbound HTTP. */
  discoveryRunner?: typeof runDiscoveryCached;
  /** All-surface probe seam. Defaults to probeAllSelfDescriptionLinks;
   *  overridable in tests so multi-kind link attachment and non-fatal probe
   *  failure can be asserted without real outbound HTTP. */
  probeRunner?: typeof probeAllSelfDescriptionLinks;
}

/** Desired sub-minute (`every:N`) schedules, keyed by schedule key.
 *  Cron-mode schedules are not part of desired state — they are fired
 *  directly by `reconcileWorkflowSchedules` on each 60s pass. */
type EveryDesiredState = Map<
  string,
  { schedule_id: string; seconds: number; payload: ExecutionRunJob }
>;

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
 * the calendar-gate contract:
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
  private lastConnectionRefreshAt: Date | null = null;

  /** Last instant the chat_events_seen retention sweep ran. */
  private lastChatDedupCleanupAt: Date | null = null;
  private lastConversationTitleSweepAt: Date | null = null;

  /** Last instant the cli_notification_inbox retention sweep ran. */
  private lastNotificationInboxRetentionAt: Date | null = null;

  /** Last instant the tool_approvals retention sweep ran. */
  private lastToolApprovalsCleanupAt: Date | null = null;

  /** Last instant the approval-backed elicitation expiry sweep ran. */
  private lastElicitationExpiryAt: Date | null = null;

  /** Last instant the embedding backfill sweep ran. In-process throttle to
   *  EMBEDDING_BACKFILL_CADENCE_MS; the sweep is idempotent so overlap is safe. */
  private lastEmbeddingBackfillAt: Date | null = null;

  /** Last instant the connector self-description enrichment sweep ran. Same
   *  in-process throttle as the cleanup sweeps; deferred off the boot path
   *  because the first sweep makes bounded outbound discovery HTTP calls. */
  private lastConnectorSelfDescriptionAt: Date | null = null;

  /** Resolved discovery runner — the injectable seam, defaulting to the real
   *  cached discovery pipeline. */
  private readonly discoveryRunner: typeof runDiscoveryCached;

  /** Resolved all-surface probe — the injectable seam, defaulting to the
   *  real concurrent probe implementation. */
  private readonly probeRunner: typeof probeAllSelfDescriptionLinks;

  constructor(private readonly opts: ReconcilerOptions) {
    this.discoveryRunner = opts.discoveryRunner ?? runDiscoveryCached;
    this.probeRunner = opts.probeRunner ?? probeAllSelfDescriptionLinks;
  }

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
    await retryTransient(() => this.reconcileDocsAutoRefresh(), {
      label: "docs_auto_refresh",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "docs_refresh_failed",
        msg: "scheduler docs auto-refresh pass failed",
        ...errorFields(err),
      });
    });
    await retryTransient(() => this.reconcileKnowledgeAutoRefresh(), {
      label: "knowledge_auto_refresh",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "knowledge_refresh_failed",
        msg: "scheduler knowledge auto-refresh pass failed",
        ...errorFields(err),
      });
    });
    // Connector self-description enrichment runs on the same tick. Throttled
    // in-process to one sweep per cadence; each sweep refreshes a small,
    // oldest-first batch of HTTP/GraphQL connectors via runDiscoveryCached,
    // which re-warms the discovery cache and records the connector's
    // self-description LINKS. Per-connector failures are non-fatal.
    await retryTransient(() => this.reconcileConnectorSelfDescription(), {
      label: "connector_self_description",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "connector_self_description_failed",
        msg: "scheduler connector self-description enrichment pass failed",
        ...errorFields(err),
      });
    });
    // Workflow schedule fan-out is dedup'd via `last_enqueued_at`. The
    // reconciler itself walks every cron-mode schedule, asks
    // `isCronDue()` whether one full cron period has elapsed since the
    // last enqueue, and only THEN fires an execution.run job. A
    // 10-minute outage that brings a `* * * * *` schedule "10 minutes
    // behind" therefore produces ONE catch-up enqueue, not 10.
    await retryTransient(() => this.reconcileWorkflowSchedules(), {
      label: "workflow_schedules",
    }).catch((err) => {
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
    await retryTransient(() => this.reconcileProactiveDriftScans(), {
      label: "drift_scan",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "drift_scan_failed",
        msg: "scheduler proactive drift scan pass failed",
        ...errorFields(err),
      });
    });
    // Proactive connector re-auth scan. Per-tenant CAS-stamp on
    // `tenants.last_connector_reauth_scan_at` gives multi-instance
    // deployments exactly-once firing per cadence; each due tenant gets
    // a lightweight authenticated probe per connector so stale or revoked
    // credentials are flagged before a workflow hits them at runtime.
    await retryTransient(() => this.reconcileConnectorReauthScans(), {
      label: "connector_reauth_scan",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "connector_reauth_scan_failed",
        msg: "scheduler connector re-auth scan pass failed",
        ...errorFields(err),
      });
    });
    // Proactive endpoint-contract scan. Per-tenant CAS-stamp on
    // `tenants.last_endpoint_contract_scan_at`; each due tenant gets the
    // distinct GET operations its committed workflows reference probed
    // through the normal authed path — a vendor's 410 or Deprecation/
    // Sunset announcement flips connector+workflow health BEFORE an
    // unattended run returns "0 results".
    await retryTransient(() => this.reconcileEndpointContractScans(), {
      label: "endpoint_contract_scan",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "endpoint_contract_scan_failed",
        msg: "scheduler endpoint-contract scan pass failed",
        ...errorFields(err),
      });
    });
    // Skill-candidate pattern analysis. Per-tenant CAS-stamp on
    // `tenants.last_skill_candidate_analyze_at` gives multi-instance
    // deployments exactly-once firing per cadence; each due tenant gets a
    // `skill-candidate.analyze` job enqueued, whose worker runs
    // runPatternAnalysis (repair / failure / success detectors → Skill
    // Candidate proposals behind the operator-approval gate).
    await retryTransient(() => this.reconcileSkillCandidateAnalysis(), {
      label: "skill_candidate_analyze",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "skill_candidate_analyze_failed",
        msg: "scheduler skill-candidate analysis pass failed",
        ...errorFields(err),
      });
    });
    // Unified-files cleanup cron. Hour-throttled in-process;
    // multi-instance overlap is safe — see the cadence
    // constant comment. The runner walks three sweeps (pending
    // orphans, unlinked TTL, LLM provider expiry); errors inside the
    // sweeps are caught per-sweep so a failure does not abort the rest
    // of the reconciler tick.
    await retryTransient(() => this.reconcileFilesCleanup(), {
      label: "files_cleanup",
    }).catch((err) => {
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
    await retryTransient(() => this.reconcileMcpOAuthCleanup(), {
      label: "mcp_oauth_cleanup",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "mcp_oauth_cleanup_failed",
        msg: "scheduler MCP OAuth cleanup pass failed",
        ...errorFields(err),
      });
    });
    // Outbound connections: renew every grant whose token ends within the
    // refresh buffer, so a connection nobody used today still works tomorrow.
    await retryTransient(() => this.reconcileConnectionRefresh(), {
      label: "connection_refresh",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "connection_refresh_failed",
        msg: "scheduler outbound-connection refresh pass failed",
        ...errorFields(err),
      });
    });
    // chat_events_seen retention sweep. Same hour-throttle pattern;
    // bounds the replay-dedup table as inbound Slack volume grows.
    // Names the conversations nobody has touched since auto-titling shipped.
    await retryTransient(() => this.reconcileConversationTitleSweep(), {
      label: "conversation_title_sweep",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "conversation_title_sweep_failed",
        msg: "scheduler dormant-conversation titling pass failed",
        ...errorFields(err),
      });
    });
    await retryTransient(() => this.reconcileChatDedupCleanup(), {
      label: "chat_dedup_cleanup",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "chat_dedup_cleanup_failed",
        msg: "scheduler chat-dedup cleanup pass failed",
        ...errorFields(err),
      });
    });
    // cli_notification_inbox retention sweep. Same hour-throttle pattern;
    // `ack` marks read instead of deleting, so this is the only path that
    // ever removes an inbox row.
    await retryTransient(() => this.reconcileNotificationInboxRetention(), {
      label: "notification_inbox_retention",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "notification_inbox_retention_failed",
        msg: "scheduler notification-inbox retention pass failed",
        ...errorFields(err),
      });
    });
    // tool_approvals retention sweep. Same hour-throttle pattern; bounds how
    // long the encrypted approved-args ciphertext survives its own TTL.
    await retryTransient(() => this.reconcileToolApprovalsCleanup(), {
      label: "tool_approvals_cleanup",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "tool_approvals_cleanup_failed",
        msg: "scheduler tool-approvals cleanup pass failed",
        ...errorFields(err),
      });
    });
    // Approval-backed elicitation expiry sweep. The tool_approvals sweep
    // above only deletes approval rows; this one resolves the pending
    // elicitations those dead approvals left behind and reactivates their
    // stranded `awaiting_input` conversations. Per-row errors are caught
    // inside the runner so a poisoned row never aborts the tick.
    await retryTransient(() => this.reconcileElicitationExpiry(), {
      label: "elicitation_expiry",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "elicitation_expiry_failed",
        msg: "scheduler elicitation expiry pass failed",
        ...errorFields(err),
      });
    });
    await retryTransient(() => this.reconcileEmbeddingBackfill(), {
      label: "embedding_backfill",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "embedding_backfill_failed",
        msg: "scheduler embedding backfill pass failed",
        ...errorFields(err),
      });
    });
    const desired = await retryTransient(() => this.computeDesired(), {
      label: "compute_desired",
    });

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
        void this.fireEvery(key, def).catch((err) => {
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
      // Never fire schedules for soft-deleted or archived workflows. An
      // archived workflow is retired; its schedule rows may still exist
      // (archive does not unbind them), so gate here as well as pausing on
      // archive, so a retired-but-scheduled workflow stops running.
      .where(
        and(
          eq(workflowsSchedules.paused, false),
          isNull(workflows.deleted_at),
          ne(workflows.lifecycle, "archived"),
        ),
      );

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
      // `last` is the actual column value — the CAS below and the failure
      // compensation must operate on it verbatim. The DUE baseline is
      // separate: a never-fired schedule uses its creation time, because
      // `isCronDue(null)`'s "always due" would fire a fresh daily-07:00
      // schedule immediately at whatever time it was created (observed
      // live: a surprise scheduled run two minutes after authoring, then
      // the real 07:00 fire). First fire = first occurrence AFTER creation.
      const last = schedule.last_enqueued_at ?? null;
      const dueBaseline = last ?? schedule.created_at;
      if (!isCronDue(schedule.cron, dueBaseline, now, tz)) continue;
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
          execution_mode: schedule.execution_mode,
        };
        // Stamp `last_enqueued_at = now` BEFORE the enqueue so a crash
        // mid-fire cannot replay the schedule on next boot.
        //
        // Compare-and-set on `last_enqueued_at`: only update if the
        // value is still the one we just read (or was NULL). If two
        // reconcilers run concurrently, exactly one wins this UPDATE
        // and the other's RETURNING comes back empty — the loser
        // skips fireWorkflowSchedule and the schedule fires once.
        //
        // The equality is taken at millisecond precision via date_trunc:
        // node-postgres truncates the read-back timestamptz to ms, so a
        // raw `= last` against a stored value carrying sub-millisecond
        // microseconds would never match, silently stalling the schedule.
        // Truncating both sides keeps the CAS microsecond-safe while
        // preserving exactly-once (the old snapshot's ms value only
        // matches until the winner advances the column).
        const priorWhere =
          last === null
            ? isNull(workflowsSchedules.last_enqueued_at)
            : sql`date_trunc('milliseconds', ${workflowsSchedules.last_enqueued_at}) = ${last}`;
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
        // Compensate: we stamped last_enqueued_at = now BEFORE firing, but
        // the fire threw (e.g. transient boss.send / DB blip). Without this,
        // the occurrence is stamped "fired" yet never ran — silently lost
        // until the next natural cron tick. Restore the prior watermark so
        // the next reconcile tick retries it. Guarded on our own stamp
        // (last_enqueued_at still == now) so a concurrent winner isn't
        // clobbered. A process CRASH between stamp and fire runs no catch,
        // so the deliberate at-most-once crash-safety is preserved.
        try {
          await this.opts.db
            .update(workflowsSchedules)
            .set({ last_enqueued_at: last })
            .where(
              and(
                eq(workflowsSchedules.id, schedule.id),
                sql`date_trunc('milliseconds', ${workflowsSchedules.last_enqueued_at}) = ${now}`,
              ),
            );
        } catch (compErr) {
          logger.error({
            module: "scheduler",
            action: "schedule.fanout_compensate_failed",
            msg: "failed to restore last_enqueued_at after a failed fire",
            schedule_id: schedule.id,
            ...errorFields(compErr),
          });
        }
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
    // Atomic claim: a single UPDATE flips every due tenant's stamp to `now`
    // and RETURNs the ids it actually changed. Range-based (`<` / NULL) so
    // it is microsecond-safe — never an equality on a millisecond-truncated
    // read-back Date (which silently matched 0 rows whenever the stored
    // stamp carried sub-millisecond microseconds). Exactly-once across
    // instances is preserved by row locks: a concurrent reconciler's UPDATE
    // blocks, then re-evaluates the WHERE against the now-advanced stamp (no
    // longer `< cutoff`) and skips the row.
    const claimed = await this.opts.db
      .update(tenants)
      .set({ last_proactive_scan_at: now })
      .where(
        and(
          isNull(tenants.deleted_at),
          or(
            isNull(tenants.last_proactive_scan_at),
            lt(tenants.last_proactive_scan_at, cadenceCutoff),
          ),
        ),
      )
      .returning({ id: tenants.id });

    for (const tenant of claimed) {
      // The runner is designed not to throw (per-tenant failures land as
      // status='failed' on the scan row), but a defensive catch keeps one
      // tenant's failure from skipping the rest of the already-claimed batch.
      try {
        await runProactiveDriftScanForTenant(tenant.id, now, this.opts.db);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "drift_scan_failed",
          msg: "proactive drift scan threw for tenant — continuing with the rest",
          tenant_id: tenant.id,
          ...errorFields(err),
        });
      }
    }
  }

  /**
   * Proactive connector re-auth scan. Each live tenant whose
   * `last_connector_reauth_scan_at` is NULL or older than the cadence
   * wins an atomic CAS-stamp and has all of its probeable connectors
   * checked with a lightweight authenticated request. Any connector
   * whose response classifies as `auth_failed` is atomically flagged
   * and an operator notification is emitted — exactly once per
   * false→true transition (dedup guard inside markConnectorNeedsReauth).
   *
   * The same claim also drives the oauth2 refresh keep-alive sweep
   * (`runOAuth2RefreshKeepAliveForTenant`): multi-day-idle credentials
   * get a proactive `connector.refresh-oauth` job so their refresh
   * tokens don't die of IdP idle-expiry. It runs after the probe scan
   * so connectors flagged this hour are excluded the same hour.
   *
   * Same microsecond-safe range-based UPDATE claim pattern as the drift
   * scan: the predicate uses `< cutoff` / `IS NULL` so sub-millisecond
   * microseconds in the stored timestamp never cause a missed claim.
   */
  async reconcileConnectorReauthScans(now: Date = new Date()): Promise<void> {
    // tenant-filter:exempt — connector re-auth scan sweeps every tenant; row carries tenant_id forward
    const cadenceCutoff = new Date(now.getTime() - CONNECTOR_REAUTH_SCAN_CADENCE_MS);
    const claimed = await this.opts.db
      .update(tenants)
      .set({ last_connector_reauth_scan_at: now })
      .where(
        and(
          isNull(tenants.deleted_at),
          or(
            isNull(tenants.last_connector_reauth_scan_at),
            lt(tenants.last_connector_reauth_scan_at, cadenceCutoff),
          ),
        ),
      )
      .returning({ id: tenants.id });

    for (const tenant of claimed) {
      try {
        await runConnectorReauthScanForTenant(tenant.id, now, this.opts.db);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "connector_reauth_scan_failed",
          msg: "connector re-auth scan threw for tenant — continuing with the rest",
          tenant_id: tenant.id,
          ...errorFields(err),
        });
      }
      try {
        await runOAuth2RefreshKeepAliveForTenant(tenant.id, now, this.opts.db, this.opts.boss);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "oauth2_keepalive_failed",
          msg: "oauth2 refresh keep-alive sweep threw for tenant — continuing with the rest",
          tenant_id: tenant.id,
          ...errorFields(err),
        });
      }
    }
  }

  /**
   * Skill-candidate pattern analysis. Each live tenant whose
   * `last_skill_candidate_analyze_at` is NULL or older than the cadence
   * wins a CAS-stamp and gets a `skill-candidate.analyze` job enqueued
   * exactly once per cadence. The worker runs `runPatternAnalysis`, which
   * fans out to the repair / failure / success detectors and upserts Skill
   * Candidate proposals (always `status='proposed'` — promotion to a Skill
   * stays behind the operator-approval gate).
   *
   * Enqueue failures are caught per-tenant: the CAS-stamp has already
   * advanced, so a transient enqueue error simply waits for the next
   * cadence rather than hot-looping; the sweep keeps walking the other
   * tenants.
   */
  /**
   * Proactive endpoint-contract scan. Same microsecond-safe CAS-stamp
   * claim as the re-auth scan, on `last_endpoint_contract_scan_at`. The
   * per-tenant sweep lives in `endpoint-contract-scan-runner.ts`.
   */
  async reconcileEndpointContractScans(now: Date = new Date()): Promise<void> {
    // tenant-filter:exempt — contract scan sweeps every tenant; row carries tenant_id forward
    const cadenceCutoff = new Date(now.getTime() - ENDPOINT_CONTRACT_SCAN_CADENCE_MS);
    const claimed = await this.opts.db
      .update(tenants)
      .set({ last_endpoint_contract_scan_at: now })
      .where(
        and(
          isNull(tenants.deleted_at),
          or(
            isNull(tenants.last_endpoint_contract_scan_at),
            lt(tenants.last_endpoint_contract_scan_at, cadenceCutoff),
          ),
        ),
      )
      .returning({ id: tenants.id });

    for (const tenant of claimed) {
      try {
        await runEndpointContractScanForTenant(tenant.id, now, this.opts.db);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "endpoint_contract_scan_failed",
          msg: "endpoint-contract scan threw for tenant — continuing with the rest",
          tenant_id: tenant.id,
          ...errorFields(err),
        });
      }
    }
  }

  async reconcileSkillCandidateAnalysis(now: Date = new Date()): Promise<void> {
    await runSkillCandidateAnalysisSweep(now, this.opts.db, this.opts.boss);
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
   * Renew outbound connections that are about to expire. Overlap between
   * instances is harmless: a second refresh of the same grant mints one more
   * version and revokes the one before it.
   */
  async reconcileConnectionRefresh(now: Date = new Date()): Promise<void> {
    if (this.lastConnectionRefreshAt !== null) {
      const elapsed = now.getTime() - this.lastConnectionRefreshAt.getTime();
      if (elapsed < CONNECTION_REFRESH_CADENCE_MS) return;
    }
    this.lastConnectionRefreshAt = now;
    const report = await refreshDueConnections(this.opts.db, now);
    if (report.refreshed > 0 || report.failed > 0) {
      logger.info({
        module: "scheduler",
        action: "connection_refresh",
        msg: "outbound connections refreshed",
        refreshed: report.refreshed,
        failed: report.failed,
      });
    }
  }

  /**
   * Throttle the dormant-conversation titling sweep. Overlap between
   * instances is safe: the sweep's write is guarded by
   * `title_locked = false` and a conversation that has been renamed no
   * longer matches its derived title, so the loser of the race skips it.
   */
  async reconcileConversationTitleSweep(now: Date = new Date()): Promise<void> {
    if (this.lastConversationTitleSweepAt !== null) {
      const elapsed = now.getTime() - this.lastConversationTitleSweepAt.getTime();
      if (elapsed < CONVERSATION_TITLE_SWEEP_CADENCE_MS) return;
    }
    this.lastConversationTitleSweepAt = now;
    await runConversationTitleSweepSafely(this.opts.db);
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

  /**
   * Throttle the `cli_notification_inbox` retention sweep. Same semantics
   * as `reconcileChatDedupCleanup` — the sweep filters by
   * `now() - notifications.inbox.retention_days`, so a concurrent
   * instance is a no-op.
   */
  async reconcileNotificationInboxRetention(now: Date = new Date()): Promise<void> {
    if (this.lastNotificationInboxRetentionAt !== null) {
      const elapsed = now.getTime() - this.lastNotificationInboxRetentionAt.getTime();
      if (elapsed < NOTIFICATION_INBOX_RETENTION_CADENCE_MS) return;
    }
    this.lastNotificationInboxRetentionAt = now;
    await runNotificationInboxRetention(now, this.opts.db);
  }

  /**
   * Throttle the `tool_approvals` retention sweep. Same semantics as
   * `reconcileMcpOAuthCleanup` — the sweeps are filtered by
   * `now() - interval '1 day'` so a concurrent instance is a no-op.
   */
  async reconcileToolApprovalsCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastToolApprovalsCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastToolApprovalsCleanupAt.getTime();
      if (elapsed < TOOL_APPROVALS_CLEANUP_CADENCE_MS) return;
    }
    this.lastToolApprovalsCleanupAt = now;
    await runToolApprovalsCleanup(now, this.opts.db);
  }

  /**
   * Throttle the approval-backed elicitation expiry sweep. Same
   * semantics as `reconcileToolApprovalsCleanup` — the sweep's writes
   * ride CAS predicates (`status = 'pending'`, `status =
   * 'awaiting_input'`) so a concurrent instance is a no-op.
   */
  async reconcileElicitationExpiry(now: Date = new Date()): Promise<void> {
    if (this.lastElicitationExpiryAt !== null) {
      const elapsed = now.getTime() - this.lastElicitationExpiryAt.getTime();
      if (elapsed < ELICITATION_EXPIRY_CADENCE_MS) return;
    }
    this.lastElicitationExpiryAt = now;
    // Supply the resume channel so the sweep can COMPLETE an approval a human
    // already granted, not only expire one that lapsed. The portal route
    // normally does this in the human's own request; this is the backstop for a
    // decision whose resume was interrupted (`conversation.run-turn` never
    // retries on its own).
    await runElicitationExpiry(now, this.opts.db, {
      resume: (resume) => enqueueApprovalElicitationResume(resume, this.opts.db, this.opts.boss),
    });
  }

  /**
   * Populate embeddings out-of-band on a fixed cadence — chunk + conversation
   * topic vectors for hybrid retrieval and topic routing. Bounded per tick
   * (maxBatches) so a backlog drains gradually rather than blocking one tick;
   * idempotent (WHERE embedding IS NULL) so a concurrent instance is a no-op,
   * and a no-op when the local model is unavailable (embedded: 0, fast).
   */
  async reconcileEmbeddingBackfill(now: Date = new Date()): Promise<void> {
    // Defer the first sweep off the boot path. The initial reconcileOnce()
    // is awaited inside the boot sequence, before the HTTP listener binds;
    // with the local model active a first backfill embeds the whole backlog
    // in-process (WASM inference), which blocks /health from ever coming
    // up and balloons RSS. Seeding lastRun on the first call moves the first
    // real sweep to one cadence after boot, once the engine is serving.
    if (this.lastEmbeddingBackfillAt === null) {
      this.lastEmbeddingBackfillAt = now;
      return;
    }
    const elapsed = now.getTime() - this.lastEmbeddingBackfillAt.getTime();
    if (elapsed < EMBEDDING_BACKFILL_CADENCE_MS) return;
    this.lastEmbeddingBackfillAt = now;
    // Small per-tick cap: the WASM embedder's arena only grows, so a large
    // sweep sets a high RSS water mark. Drain the backlog gradually instead.
    await backfillEmbeddings({ maxBatches: 4 }, this.opts.db);
  }

  /**
   * Connector self-description enrichment. Throttled in-process to one sweep
   * per CONNECTOR_SELF_DESCRIPTION_CADENCE_MS so every HTTP/GraphQL connector
   * is refreshed at most once per cadence. Each sweep re-runs cached discovery
   * (force_refresh) for a small, oldest-first batch — re-warming the discovery
   * cache and recording the connector's self-description LINKS — so connectors
   * get richer the longer they exist and authoring quality improves with use.
   *
   * Deferred off the boot path (first call only seeds the watermark): the
   * initial reconcileOnce() is awaited during boot before the HTTP listener
   * binds, and this sweep makes bounded outbound discovery HTTP calls, so
   * running it on boot would delay /health.
   *
   * Multi-instance overlap is safe — runDiscoveryCached is idempotent (it only
   * rewrites the discovery cache + the connector's self_description metadata,
   * never config/auth).
   */
  async reconcileConnectorSelfDescription(now: Date = new Date()): Promise<void> {
    if (this.lastConnectorSelfDescriptionAt === null) {
      this.lastConnectorSelfDescriptionAt = now;
      return;
    }
    const elapsed = now.getTime() - this.lastConnectorSelfDescriptionAt.getTime();
    if (elapsed < CONNECTOR_SELF_DESCRIPTION_CADENCE_MS) return;
    this.lastConnectorSelfDescriptionAt = now;
    await instrument({
      module: "scheduler",
      action: "connector_self_description.run",
      fn: () => this.reconcileConnectorSelfDescriptionPass(),
    });
  }

  private async reconcileConnectorSelfDescriptionPass(): Promise<void> {
    // tenant-filter:exempt — enrichment sweep walks every tenant; row carries tenant_id forward
    const rows = await this.opts.db
      .select({
        id: connectors.id,
        tenant_id: connectors.tenant_id,
        base_url: connectors.base_url,
      })
      .from(connectors)
      .where(
        and(
          inArray(connectors.driver, ["http", "graphql"]),
          isNotNull(connectors.base_url),
          isNull(connectors.deleted_at),
        ),
      )
      // Connectors whose self_description.links is empty/missing sort first
      // (newly needing enrichment — the boolean is `false` for them, and
      // `false < true` in Postgres ascending order); then least-recently-
      // updated so the sweep walks the estate oldest-first across cadences.
      .orderBy(
        asc(
          sql<boolean>`jsonb_array_length(coalesce(${connectors.self_description}->'links', '[]'::jsonb)) > 0`,
        ),
        asc(connectors.updated_at),
      )
      .limit(CONNECTOR_SELF_DESCRIPTION_BATCH);

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      // base_url is non-null by the query filter; narrow for the type checker.
      if (!row.base_url) continue;
      attempted += 1;
      try {
        // Non-fatal per connector: one bad upstream must not abort the sweep.
        await this.discoveryRunner(
          {
            db: this.opts.db,
            tenant_id: row.tenant_id,
            actor_id: null,
            abortSignal: AbortSignal.timeout(CONNECTOR_SELF_DESCRIPTION_DISCOVERY_TIMEOUT_MS),
          },
          { base_url: row.base_url, connector_id: row.id, force_refresh: true },
        );
        succeeded += 1;
      } catch (err) {
        failed += 1;
        logger.warn({
          module: "scheduler",
          action: "connector_self_description_refresh_failed",
          msg: "connector self-description refresh failed — continuing with the rest",
          connector_id: row.id,
          tenant_id: row.tenant_id,
          ...errorFields(err),
        });
      }
      // Probe ALL self-description surfaces independently. The single-winner
      // interactive discovery above only captures the FIRST successful
      // strategy; the probe below broadens coverage by recording every surface
      // found (OpenAPI + llms.txt + GraphQL may all be present). Non-fatal:
      // a probe failure must not abort the sweep for the remaining connectors.
      try {
        const probeLinks = await this.probeRunner(row.base_url, {
          signal: AbortSignal.timeout(CONNECTOR_SELF_DESCRIPTION_DISCOVERY_TIMEOUT_MS),
        });
        if (probeLinks.length > 0) {
          await attachConnectorSelfDescriptionLinks(
            { tenant_id: row.tenant_id, connector_id: row.id, links: probeLinks },
            this.opts.db,
          );
        }
      } catch (probeErr) {
        logger.warn({
          module: "scheduler",
          action: "connector_self_description_probe_failed",
          msg: "connector self-description probe failed — continuing with the rest",
          connector_id: row.id,
          tenant_id: row.tenant_id,
          ...errorFields(probeErr),
        });
      }
    }
    logger.info({
      module: "scheduler",
      action: "connector_self_description_refreshed",
      msg: "connector self-description enrichment sweep complete",
      attempted,
      succeeded,
      failed,
    });
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
      execution_mode: payload.execution_mode ?? "prod",
      input: payload.input ?? null,
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
      tenant_id: payload.tenant_id,
      schedule_key: key,
      execution_id,
    });
  }

  private async fireEvery(
    key: string,
    def: { schedule_id: string; seconds: number; payload: ExecutionRunJob },
  ): Promise<void> {
    const { schedule_id, seconds, payload } = def;
    // Cross-instance dedup: claim this cadence via a CAS on the schedule's
    // last_enqueued_at before doing anything. The every-timer is per-process,
    // so without this every running instance would fire the same cadence —
    // an N× duplicate on any multi-instance deployment. Only claim if a full
    // cadence (with jitter slack) has elapsed since the last fire; the loser
    // (or a near-simultaneous peer) gets 0 rows back and skips. Reuses the
    // existing column — no migration. (date_trunc keeps it microsecond-safe.)
    const now = new Date();
    const minGapMs = Math.max(1000, seconds * 1000 * 0.5);
    const threshold = new Date(now.getTime() - minGapMs);
    const claimed = await this.opts.db
      .update(workflowsSchedules)
      .set({ last_enqueued_at: now })
      .where(
        and(
          eq(workflowsSchedules.id, schedule_id),
          or(
            isNull(workflowsSchedules.last_enqueued_at),
            lt(workflowsSchedules.last_enqueued_at, threshold),
          ),
        ),
      )
      .returning({ id: workflowsSchedules.id });
    if (claimed.length === 0) return;
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
      execution_mode: payload.execution_mode ?? "prod",
      input: payload.input ?? null,
    });
    const job: ExecutionRunJob = { ...payload, execution_id, request_source: "scheduler" };
    await this.opts.boss.send(EXECUTION_RUN_QUEUE, job);
    logger.info({
      module: "scheduler",
      action: "schedule.fired",
      msg: "every-schedule enqueued execution.run",
      tenant_id: payload.tenant_id,
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
      // Never fire schedules for soft-deleted or archived workflows. An
      // archived workflow is retired; its schedule rows may still exist
      // (archive does not unbind them), so gate here as well as pausing on
      // archive, so a retired-but-scheduled workflow stops running.
      .where(
        and(
          eq(workflowsSchedules.paused, false),
          isNull(workflows.deleted_at),
          ne(workflows.lifecycle, "archived"),
        ),
      );

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
        execution_mode: schedule.execution_mode,
      };
      // Cron-mode schedules are fired directly by
      // `reconcileWorkflowSchedules`; only `every:N` schedules need a
      // local interval timer installed.
      if (parsed.mode === "every" && parsed.everySeconds !== undefined) {
        every.set(key, { schedule_id: schedule.id, seconds: parsed.everySeconds, payload });
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
