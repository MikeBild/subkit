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
import { admitAuthorizedWorkflowExecution } from "../execution/authority-admission.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { enqueueApprovalElicitationResume } from "../queue/approval-resume.ts";
import { enqueueIngest, INGEST_DOCS_QUEUE } from "../queue/handlers/ingest-docs.ts";
import {
  enqueueKnowledgeIngest,
  INGEST_KNOWLEDGE_QUEUE,
} from "../queue/handlers/ingest-knowledge.ts";
import { enqueueGateDiagnosis } from "../queue/handlers/workflow-repair.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queue/queues.ts";
import {
  calendarGateSkipReason,
  localDateInTz,
  readCalendarGates,
  stripCalendarGates,
} from "./calendar-gates.ts";
import { runCatalogDescribeSweep } from "./catalog-describe-runner.ts";
import { runChatDedupCleanup } from "./chat-dedup-cleanup-runner.ts";
import {
  runConnectorReauthScanForTenant,
  runOAuth2RefreshKeepAliveForTenant,
} from "./connector-reauth-scan-runner.ts";
import { runConversationTitleSweepSafely } from "./conversation-title-runner.ts";
import { nextCronOccurrence, parseCronExpression } from "./cron.ts";
import { runElicitationExpiry } from "./elicitation-expiry-runner.ts";
import { runEndpointContractScanForTenant } from "./endpoint-contract-scan-runner.ts";
import { runFilesCleanup } from "./files-cleanup-runner.ts";
import { runMcpOAuthCleanup } from "./mcp-oauth-cleanup-runner.ts";
import { runNotificationInboxRetention } from "./notification-inbox-retention-runner.ts";
import { runProactiveDriftScanForTenant } from "./proactive-drift-scan-runner.ts";
import { validateScheduleInput } from "./repo.ts";
import { runRiskSignalEdges } from "./risk-signal-edges-runner.ts";
import {
  recordScheduleAdmission,
  recordScheduleInputRequired,
} from "./schedule-admission-state.ts";
import { logScheduleFireFailure } from "./schedule-fire-failure.ts";
import { runSkillCandidateAnalysisSweep } from "./skill-candidate-analyze-runner.ts";
import { runToolApprovalsCleanup } from "./tool-approvals-cleanup-runner.ts";

const PROACTIVE_DRIFT_SCAN_CADENCE_MS = 60 * 60 * 1000;

const CONNECTOR_REAUTH_SCAN_CADENCE_MS = 60 * 60 * 1000;
const ENDPOINT_CONTRACT_SCAN_CADENCE_MS = 6 * 60 * 60 * 1000;

const FILES_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

const MCP_OAUTH_CLEANUP_CADENCE_MS = 60 * 60 * 1000;
const CONNECTION_REFRESH_CADENCE_MS = 60 * 1000;

const CHAT_DEDUP_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

const CONVERSATION_TITLE_SWEEP_CADENCE_MS = 5 * 60 * 1000;

const NOTIFICATION_INBOX_RETENTION_CADENCE_MS = 60 * 60 * 1000;

const TOOL_APPROVALS_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

const ELICITATION_EXPIRY_CADENCE_MS = 5 * 60 * 1000;

const RISK_SIGNAL_EDGE_CADENCE_MS = 60 * 1000;

const EMBEDDING_BACKFILL_CADENCE_MS = 5 * 60 * 1000;

const CONNECTOR_SELF_DESCRIPTION_CADENCE_MS = 24 * 60 * 60 * 1000;
const CONNECTOR_SELF_DESCRIPTION_BATCH = 10;
const CONNECTOR_SELF_DESCRIPTION_DISCOVERY_TIMEOUT_MS = 8_000;

export interface ReconcilerOptions {
  boss: PgBoss;
  db: Db;
  intervalMs?: number;
  discoveryRunner?: typeof runDiscoveryCached;
  probeRunner?: typeof probeAllSelfDescriptionLinks;
}

type EveryDesiredState = Map<
  string,
  { schedule_id: string; seconds: number; payload: ExecutionRunJob }
>;

function scheduleKeyForRow(row: { id: string }): string {
  return `wf-schedule.${row.id}`;
}

export function isCronDue(cron: string, lastFiredAt: Date | null, now: Date, tz?: string): boolean {
  const trimmed = cron.trim();
  if (trimmed.startsWith("every:")) {
    const seconds = Number.parseFloat(trimmed.slice("every:".length));
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    if (!lastFiredAt) return true;
    return now.getTime() - lastFiredAt.getTime() >= seconds * 1000;
  }
  if (!lastFiredAt) return true;
  const next = nextCronOccurrence(trimmed, lastFiredAt, tz);
  return next !== null && now.getTime() >= next.getTime();
}

export class SchedulerReconciler {
  private timer: NodeJS.Timeout | null = null;
  private everyTimers: Map<string, NodeJS.Timeout> = new Map();
  private installed: Map<string, string> = new Map();
  private stopped = false;
  private inFlight = new Set<Promise<unknown>>();

  private track<T>(task: Promise<T>): Promise<T> {
    this.inFlight.add(task);
    void task.then(
      () => this.inFlight.delete(task),
      () => this.inFlight.delete(task),
    );
    return task;
  }
  private lastFilesCleanupAt: Date | null = null;

  private lastMcpOAuthCleanupAt: Date | null = null;
  private lastConnectionRefreshAt: Date | null = null;

  private lastChatDedupCleanupAt: Date | null = null;
  private lastConversationTitleSweepAt: Date | null = null;

  private lastNotificationInboxRetentionAt: Date | null = null;

  private lastToolApprovalsCleanupAt: Date | null = null;

  private lastElicitationExpiryAt: Date | null = null;

  private lastRiskSignalEdgesAt: Date | null = null;

  private lastEmbeddingBackfillAt: Date | null = null;

  private lastConnectorSelfDescriptionAt: Date | null = null;

  private readonly discoveryRunner: typeof runDiscoveryCached;

  private readonly probeRunner: typeof probeAllSelfDescriptionLinks;

  constructor(private readonly opts: ReconcilerOptions) {
    this.discoveryRunner = opts.discoveryRunner ?? runDiscoveryCached;
    this.probeRunner = opts.probeRunner ?? probeAllSelfDescriptionLinks;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.track(this.reconcileOnce());
    if (this.stopped) return;
    const period = this.opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.track(this.reconcileOnce()).catch((err) => {
        logger.error({
          module: "scheduler",
          action: "reconcile_failed",
          msg: "scheduler reconcile pass failed",
          ...errorFields(err),
        });
      });
    }, period);
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
    await Promise.allSettled([...this.inFlight]);
    for (const timer of this.everyTimers.values()) clearInterval(timer);
    this.everyTimers.clear();
    this.installed.clear();
  }

  async reconcileOnce(): Promise<void> {
    if (this.stopped) return;
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
    await retryTransient(() => this.reconcileCatalogDescribe(), {
      label: "catalog_describe",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "catalog_describe_failed",
        msg: "scheduler catalog description pass failed",
        ...errorFields(err),
      });
    });
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
    await retryTransient(() => this.reconcileRiskSignalEdges(), {
      label: "risk_signal_edges",
    }).catch((err) => {
      logger.error({
        module: "scheduler",
        action: "risk_signal_edges_failed",
        msg: "scheduler risk-signal edge pass failed",
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

    for (const [key, def] of desired) {
      const sig = `every|${def.seconds}|${JSON.stringify(def.payload)}`;
      if (this.installed.get(key) === sig) continue;
      const prior = this.everyTimers.get(key);
      if (prior) clearInterval(prior);
      const timer = setInterval(() => {
        if (this.stopped) return;
        void this.track(this.fireEvery(key, def)).catch((err) => {
          logScheduleFireFailure(
            err,
            {
              tenant_id: def.payload.tenant_id,
              workflow_id: def.payload.workflow_id,
              schedule_id: def.schedule_id,
              schedule_key: key,
            },
            "schedule.fire_failed",
          );
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
      .where(
        and(
          eq(workflowsSchedules.paused, false),
          isNull(workflows.deleted_at),
          ne(workflows.lifecycle, "archived"),
        ),
      );

    for (const { schedule, wf } of rows) {
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
      if (parsed.mode === "every") continue;
      const tz = schedule.timezone || "UTC";
      const last = schedule.last_enqueued_at ?? null;
      const dueBaseline = last ?? schedule.created_at;
      if (!isCronDue(schedule.cron, dueBaseline, now, tz)) continue;
      const inputError = await validateScheduleInput(
        this.opts.db,
        schedule.tenant_id,
        schedule.workflow_id,
        schedule.input,
      );
      if (inputError) {
        await recordScheduleInputRequired(
          this.opts.db,
          { tenant_id: schedule.tenant_id, schedule_id: schedule.id, observed_at: now },
          inputError,
        );
        continue;
      }
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
          occurrence_after: dueBaseline,
          claimed_at: now,
        });
      } catch (err) {
        logScheduleFireFailure(
          err,
          {
            tenant_id: wf.tenant_id,
            workflow_id: wf.id,
            schedule_id: schedule.id,
          },
          "schedule.fanout_failed",
        );
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

  async reconcileProactiveDriftScans(now: Date = new Date()): Promise<void> {
    // tenant-filter:exempt — proactive drift scan sweeps every tenant; row carries tenant_id forward
    const cadenceCutoff = new Date(now.getTime() - PROACTIVE_DRIFT_SCAN_CADENCE_MS);
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

  async reconcileCatalogDescribe(): Promise<void> {
    await runCatalogDescribeSweep(this.opts.db, this.opts.boss);
  }

  async reconcileFilesCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastFilesCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastFilesCleanupAt.getTime();
      if (elapsed < FILES_CLEANUP_CADENCE_MS) return;
    }
    this.lastFilesCleanupAt = now;
    await runFilesCleanup(now, this.opts.db);
  }

  async reconcileRiskSignalEdges(now: Date = new Date()): Promise<void> {
    if (this.lastRiskSignalEdgesAt !== null) {
      const elapsed = now.getTime() - this.lastRiskSignalEdgesAt.getTime();
      if (elapsed < RISK_SIGNAL_EDGE_CADENCE_MS) return;
    }
    await runRiskSignalEdges(this.opts.db);
    this.lastRiskSignalEdgesAt = now;
  }

  async reconcileMcpOAuthCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastMcpOAuthCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastMcpOAuthCleanupAt.getTime();
      if (elapsed < MCP_OAUTH_CLEANUP_CADENCE_MS) return;
    }
    this.lastMcpOAuthCleanupAt = now;
    await runMcpOAuthCleanup(now, this.opts.db);
  }

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

  async reconcileConversationTitleSweep(now: Date = new Date()): Promise<void> {
    if (this.lastConversationTitleSweepAt !== null) {
      const elapsed = now.getTime() - this.lastConversationTitleSweepAt.getTime();
      if (elapsed < CONVERSATION_TITLE_SWEEP_CADENCE_MS) return;
    }
    this.lastConversationTitleSweepAt = now;
    await runConversationTitleSweepSafely(this.opts.db);
  }

  async reconcileChatDedupCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastChatDedupCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastChatDedupCleanupAt.getTime();
      if (elapsed < CHAT_DEDUP_CLEANUP_CADENCE_MS) return;
    }
    this.lastChatDedupCleanupAt = now;
    await runChatDedupCleanup(now, this.opts.db);
  }

  async reconcileNotificationInboxRetention(now: Date = new Date()): Promise<void> {
    if (this.lastNotificationInboxRetentionAt !== null) {
      const elapsed = now.getTime() - this.lastNotificationInboxRetentionAt.getTime();
      if (elapsed < NOTIFICATION_INBOX_RETENTION_CADENCE_MS) return;
    }
    this.lastNotificationInboxRetentionAt = now;
    await runNotificationInboxRetention(now, this.opts.db);
  }

  async reconcileToolApprovalsCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastToolApprovalsCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastToolApprovalsCleanupAt.getTime();
      if (elapsed < TOOL_APPROVALS_CLEANUP_CADENCE_MS) return;
    }
    this.lastToolApprovalsCleanupAt = now;
    await runToolApprovalsCleanup(now, this.opts.db);
  }

  async reconcileElicitationExpiry(now: Date = new Date()): Promise<void> {
    if (this.lastElicitationExpiryAt !== null) {
      const elapsed = now.getTime() - this.lastElicitationExpiryAt.getTime();
      if (elapsed < ELICITATION_EXPIRY_CADENCE_MS) return;
    }
    this.lastElicitationExpiryAt = now;
    await runElicitationExpiry(now, this.opts.db, {
      resume: (resume) => enqueueApprovalElicitationResume(resume, this.opts.db, this.opts.boss),
    });
  }

  async reconcileEmbeddingBackfill(now: Date = new Date()): Promise<void> {
    if (this.lastEmbeddingBackfillAt === null) {
      this.lastEmbeddingBackfillAt = now;
      return;
    }
    const elapsed = now.getTime() - this.lastEmbeddingBackfillAt.getTime();
    if (elapsed < EMBEDDING_BACKFILL_CADENCE_MS) return;
    this.lastEmbeddingBackfillAt = now;
    await backfillEmbeddings({ maxBatches: 4 }, this.opts.db);
  }

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
      if (!row.base_url) continue;
      attempted += 1;
      try {
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
    audit: {
      tenant_id: string;
      schedule_id: string;
      tz: string;
      occurrence_after: Date;
      claimed_at: Date;
    },
  ): Promise<void> {
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: payload.tenant_id,
        workflow_id: payload.workflow_id,
        request_source: "scheduler",
        execution_environment: payload.execution_mode ?? "prod",
        input: payload.input ?? null,
        idempotency_key: `schedule:${audit.schedule_id}:after:${audit.occurrence_after.toISOString()}`,
      },
      this.opts.db,
    ).catch(async (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "execution_authority_required" ||
          error.code === "execution_authority_unavailable")
      ) {
        if (await recordScheduleAdmission(this.opts.db, audit, error.code))
          await enqueueGateDiagnosis(this.opts.boss, this.opts.db, {
            tenant_id: payload.tenant_id,
            workflow_id: payload.workflow_id,
            environment: payload.execution_mode ?? "prod",
            source: "schedule",
          });
      }
      throw error;
    });
    const execution_id = admitted.execution_id;
    const { input: _queuedInput, ...queuedPayload } = payload;
    const job: ExecutionRunJob = { ...queuedPayload, execution_id, request_source: "scheduler" };
    if (admitted.status === "queued")
      await this.opts.boss.send(EXECUTION_RUN_QUEUE, job, { id: execution_id });
    await recordScheduleAdmission(this.opts.db, audit, null);
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
          execution_authority_id: admitted.execution_authority_id,
          idempotent_replay: admitted.replayed,
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
    const [schedule] = await this.opts.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.id, schedule_id),
          eq(workflowsSchedules.tenant_id, payload.tenant_id),
          eq(workflowsSchedules.workflow_id, payload.workflow_id),
          eq(workflowsSchedules.paused, false),
        ),
      )
      .limit(1);
    if (!schedule) return;
    const now = new Date();
    const inputError = await validateScheduleInput(
      this.opts.db,
      schedule.tenant_id,
      schedule.workflow_id,
      schedule.input,
    );
    if (inputError) {
      await recordScheduleInputRequired(
        this.opts.db,
        { tenant_id: schedule.tenant_id, schedule_id, observed_at: now },
        inputError,
      );
      return;
    }
    const minGapMs = Math.max(1000, seconds * 1000 * 0.5);
    const threshold = new Date(now.getTime() - minGapMs);
    const claimed = await this.opts.db
      .update(workflowsSchedules)
      .set({ last_enqueued_at: now })
      .where(
        and(
          eq(workflowsSchedules.id, schedule_id),
          schedule.last_enqueued_at === null
            ? isNull(workflowsSchedules.last_enqueued_at)
            : sql`date_trunc('milliseconds', ${workflowsSchedules.last_enqueued_at}) = ${schedule.last_enqueued_at}`,
          or(
            isNull(workflowsSchedules.last_enqueued_at),
            lt(workflowsSchedules.last_enqueued_at, threshold),
          ),
        ),
      )
      .returning({ id: workflowsSchedules.id });
    if (claimed.length === 0) return;
    try {
      await this.fireWorkflowSchedule(key, payload, {
        tenant_id: payload.tenant_id,
        schedule_id,
        tz: schedule.timezone || "UTC",
        occurrence_after: schedule.last_enqueued_at ?? schedule.created_at,
        claimed_at: now,
      });
    } catch (error) {
      await this.opts.db
        .update(workflowsSchedules)
        .set({ last_enqueued_at: schedule.last_enqueued_at })
        .where(
          and(
            eq(workflowsSchedules.id, schedule_id),
            eq(workflowsSchedules.tenant_id, payload.tenant_id),
            sql`date_trunc('milliseconds', ${workflowsSchedules.last_enqueued_at}) = ${now}`,
          ),
        );
      throw error;
    }
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
        input: stripCalendarGates(schedule.input ?? null),
        request_source: "scheduler",
        execution_mode: schedule.execution_mode,
      };
      if (parsed.mode === "every" && parsed.everySeconds !== undefined) {
        every.set(key, { schedule_id: schedule.id, seconds: parsed.everySeconds, payload });
      }
    }
    return every;
  }

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
          eq(knowledgeSources.source_type, "url"),
          inArray(knowledgeSources.status, ["active", "error"]),
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
          content: "",
          actor: null,
          read_address_again: true,
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
