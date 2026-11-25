import { isAuthorityRefusalCode } from "@shared/authority-refusal.ts";
import { and, asc, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { runMcpOAuthCleanup } from "../auth/scheduled/mcp-oauth-cleanup-runner.ts";
import { runChatDedupCleanup } from "../chat/scheduled/chat-dedup-cleanup-runner.ts";
import { probeAllSelfDescriptionLinks } from "../connectors/discovery/self-description-probe.ts";
import { runDiscoveryCached } from "../connectors/discovery/service.ts";
import {
  runConnectorReauthScanForTenant,
  runOAuth2RefreshKeepAliveForTenant,
} from "../connectors/scheduled/connector-reauth-scan-runner.ts";
import { runEndpointContractScanForTenant } from "../connectors/scheduled/endpoint-contract-scan-runner.ts";
import { attachConnectorSelfDescriptionLinks } from "../connectors/service.ts";
import { deviceConfirmationPort } from "../conversations/public/elicitation.ts";
import {
  runConversationTitleSweepSafely,
  runElicitationExpiry,
} from "../conversations/public/scheduled.ts";
import { refreshDueConnections } from "../credentials/index.ts";
import type { Db } from "../db/client.ts";
import { connectors, tenants } from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { enqueueExecutionRun } from "../devices/waiting.ts";
import { backfillEmbeddings } from "../embeddings/index.ts";
import { admitSystemWorkflowExecution } from "../execution/authority-admission.ts";
import { runFilesCleanup } from "../files/scheduled/files-cleanup-runner.ts";
import { runTenantErasureSweep } from "../identity/scheduled/tenant-erasure-runner.ts";
import {
  runDocsRefreshSweep,
  runKnowledgeRefreshSweep,
} from "../knowledge/scheduled/refresh-producer-runner.ts";
import { withContext } from "../logging/context.ts";
import { errorFields, logger } from "../logging/index.ts";
import { runCockpitPushAttention } from "../notifications/scheduled/cockpit-push-attention-runner.ts";
import { runNotificationInboxRetention } from "../notifications/scheduled/notification-inbox-retention-runner.ts";
import { diagnoseOperation, runtimeDiagnosticEvent } from "../observability/runtime-diagnostics.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { runRiskSignalEdges } from "../operator/scheduled/risk-signal-edges-runner.ts";
import { enqueuePersonalNotesForTenant } from "../personal-notes/index.ts";
import { enqueueApprovalElicitationResume } from "../queue/approval-resume.ts";
import { enqueueGateDiagnosis } from "../queue/handlers/workflow-repair.ts";
import type { ExecutionRunJob } from "../queue/queues.ts";
import { runProactiveDriftScanForTenant } from "../self-healing/scheduled/proactive-drift-scan-runner.ts";
import { runSkillCandidateAnalysisSweep } from "../skill-candidates/scheduled/skill-candidate-analyze-runner.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { runToolApprovalsCleanup } from "../tools/scheduled/tool-approvals-cleanup-runner.ts";
import { runApprovalExpiryNotices } from "../workflows/scheduled/approval-expiry-notice-runner.ts";
import { runCatalogDescribeSweep } from "../workflows/scheduled/catalog-describe-runner.ts";
import { runTenantCadenceSweep } from "./cadence-sweep.ts";
import { EveryScheduleSweep } from "./every-schedule-sweep.ts";
import { ALWAYS_RUNNING, type BackgroundWork } from "./power-state.ts";
import { recordScheduleAdmission } from "./schedule-admission-state.ts";
import { logScheduleFireFailure } from "./schedule-fire-failure.ts";
import { runScheduleOccurrenceRetention } from "./schedule-occurrences.ts";
import { runTaskSweep } from "./task-sweep.ts";
import { fireEverySchedule, runWorkflowCronSweep } from "./workflow-schedule-sweep.ts";

const FILES_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

const MCP_OAUTH_CLEANUP_CADENCE_MS = 60 * 60 * 1000;
const CONNECTION_REFRESH_CADENCE_MS = 60 * 1000;

const CHAT_DEDUP_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

const CONVERSATION_TITLE_SWEEP_CADENCE_MS = 5 * 60 * 1000;

const NOTIFICATION_INBOX_RETENTION_CADENCE_MS = 60 * 60 * 1000;

const TOOL_APPROVALS_CLEANUP_CADENCE_MS = 60 * 60 * 1000;

const ELICITATION_EXPIRY_CADENCE_MS = 5 * 60 * 1000;

const RISK_SIGNAL_EDGE_CADENCE_MS = 60 * 1000;

export const COCKPIT_PUSH_ATTENTION_CADENCE_MS = 60 * 1000;

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
  cockpitPushAttentionRunner?: typeof runCockpitPushAttention;
  backgroundWork?: BackgroundWork | undefined;
}

export { isCronDue } from "./cron.ts";

export class SchedulerReconciler {
  private timer: NodeJS.Timeout | null = null;
  private readonly everySweep: EveryScheduleSweep;
  private stopped = false;
  private installation: { installed: true; firstPass: Promise<void> } | null = null;
  private inFlight = new Set<Promise<unknown>>();
  private producerPasses = new Map<string, Promise<void>>();

  private runProducerPass(producer: string, operation: () => Promise<void>): Promise<void> {
    if (this.stopped || this.producerPasses.has(producer)) return Promise.resolve();
    const task = Promise.resolve().then(() => {
      if (this.stopped) return;
      return operation();
    });
    this.producerPasses.set(producer, task);
    void this.track(task);
    const finished = () => {
      if (this.producerPasses.get(producer) === task) this.producerPasses.delete(producer);
    };
    void task.then(finished, finished);
    return task;
  }

  private async afterFanout(fanout: Promise<void>, operation: () => Promise<void>): Promise<void> {
    await fanout.catch(() => {});
    if (this.stopped) return;
    await operation();
  }

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
  private lastScheduleHousekeepingAt: Date | null = null;

  private lastToolApprovalsCleanupAt: Date | null = null;

  private lastElicitationExpiryAt: Date | null = null;

  private lastRiskSignalEdgesAt: Date | null = null;

  private lastCockpitPushAttentionAt: Date | null = null;

  private lastEmbeddingBackfillAt: Date | null = null;

  private lastConnectorSelfDescriptionAt: Date | null = null;

  private readonly discoveryRunner: typeof runDiscoveryCached;

  private readonly probeRunner: typeof probeAllSelfDescriptionLinks;
  private readonly backgroundWork: BackgroundWork;

  constructor(private readonly opts: ReconcilerOptions) {
    this.discoveryRunner = opts.discoveryRunner ?? runDiscoveryCached;
    this.probeRunner = opts.probeRunner ?? probeAllSelfDescriptionLinks;
    this.backgroundWork = opts.backgroundWork ?? ALWAYS_RUNNING;
    this.everySweep = new EveryScheduleSweep(opts.db, (definition) => {
      const key = `wf-schedule.${definition.schedule_id}`;
      let pending = false;
      const timer = setInterval(() => {
        if (this.stopped || pending) return;
        pending = true;
        void this.track(
          fireEverySchedule(this.opts.db, definition, (scheduleKey, payload, audit) =>
            this.fireWorkflowSchedule(scheduleKey, payload, audit),
          ),
        )
          .catch((error) => {
            logScheduleFireFailure(
              error,
              {
                tenant_id: definition.tenant_id,
                workflow_id: definition.workflow_id,
                schedule_id: definition.schedule_id,
                schedule_key: key,
              },
              "schedule.fire_failed",
            );
          })
          .finally(() => {
            pending = false;
          });
      }, definition.seconds * 1000);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  }

  async start(): Promise<void> {
    await this.install().firstPass;
  }

  install(): { installed: true; firstPass: Promise<void> } {
    if (this.installation) {
      if (this.stopped) throw new Error("scheduler_stopping");
      return this.installation;
    }
    this.stopped = false;
    this.everySweep.resume();
    const period = this.opts.intervalMs ?? 60_000;
    const timer = setInterval(() => {
      if (this.stopped) return;
      this.track(
        diagnoseOperation({ action: "scheduler.reconcile", fn: () => this.reconcileOnce() }),
      ).catch((err) => {
        logger.error({
          module: "scheduler",
          action: "reconcile_failed",
          msg: "scheduler reconcile pass failed",
          ...errorFields(err),
        });
      });
    }, period);
    this.timer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
    runtimeDiagnosticEvent("scheduler.first_pass.scheduled");
    const firstPass = this.track(
      Promise.resolve().then(() =>
        diagnoseOperation({ action: "scheduler.first_pass", fn: () => this.reconcileOnce() }),
      ),
    ).catch((error) => {
      if (this.timer === timer) {
        clearInterval(timer);
        this.timer = null;
      }
      throw error;
    });
    this.installation = { installed: true, firstPass };
    return this.installation;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.everySweep.stop();
    await Promise.allSettled([...this.inFlight]);
    this.installation = null;
  }

  async reconcileOnce(): Promise<void> {
    if (this.stopped) return;
    const fanoutTask = this.runProducerPass("workflow-cron", () =>
      retryTransient(() => this.reconcileWorkflowSchedules(), {
        label: "workflow_schedules",
      }).catch((err) => {
        logger.error({
          module: "scheduler",
          action: "schedule_fanout_failed",
          msg: "scheduler workflow schedule fan-out pass failed",
          ...errorFields(err),
        });
      }),
    );
    const fanout = this.producerPasses.get("workflow-cron") ?? fanoutTask;
    const producerTasks = [
      fanoutTask,
      this.runProducerPass("docs", () =>
        this.afterFanout(fanout, () =>
          retryTransient(() => this.reconcileDocsAutoRefresh(), {
            label: "docs_auto_refresh",
          }).catch((err) => {
            logger.error({
              module: "scheduler",
              action: "docs_refresh_failed",
              msg: "scheduler docs auto-refresh pass failed",
              ...errorFields(err),
            });
          }),
        ),
      ),
      this.runProducerPass("knowledge", () =>
        this.afterFanout(fanout, () =>
          retryTransient(() => this.reconcileKnowledgeAutoRefresh(), {
            label: "knowledge_auto_refresh",
          }).catch((err) => {
            logger.error({
              module: "scheduler",
              action: "knowledge_refresh_failed",
              msg: "scheduler knowledge auto-refresh pass failed",
              ...errorFields(err),
            });
          }),
        ),
      ),
      this.runProducerPass("drift", () =>
        retryTransient(() => this.reconcileProactiveDriftScans(), {
          label: "drift_scan",
        }).catch((err) => {
          logger.error({
            module: "scheduler",
            action: "drift_scan_failed",
            msg: "scheduler proactive drift scan pass failed",
            ...errorFields(err),
          });
        }),
      ),
      this.runProducerPass("reauth", () =>
        retryTransient(() => this.reconcileConnectorReauthScans(), {
          label: "connector_reauth_scan",
        }).catch((err) => {
          logger.error({
            module: "scheduler",
            action: "connector_reauth_scan_failed",
            msg: "scheduler connector re-auth scan pass failed",
            ...errorFields(err),
          });
        }),
      ),
      this.runProducerPass("endpoint-contract", () =>
        retryTransient(() => this.reconcileEndpointContractScans(), {
          label: "endpoint_contract_scan",
        }).catch((err) => {
          logger.error({
            module: "scheduler",
            action: "endpoint_contract_scan_failed",
            msg: "scheduler endpoint-contract scan pass failed",
            ...errorFields(err),
          });
        }),
      ),
      this.runProducerPass("skill", () =>
        retryTransient(() => this.reconcileSkillCandidateAnalysis(), {
          label: "skill_candidate_analyze",
        }).catch((err) => {
          logger.error({
            module: "scheduler",
            action: "skill_candidate_analyze_failed",
            msg: "scheduler skill-candidate analysis pass failed",
            ...errorFields(err),
          });
        }),
      ),
      this.runProducerPass("notes", () =>
        retryTransient(() => this.reconcilePersonalNotes(), {
          label: "personal_notes_learn",
        }).catch((err) => {
          logger.error({
            module: "scheduler",
            action: "personal_notes_learn_failed",
            msg: "scheduler personal notes pass failed",
            ...errorFields(err),
          });
        }),
      ),
      this.runProducerPass("task", () =>
        retryTransient(() => runTaskSweep(this.opts.db), { label: "task_schedules" }).catch(
          (err) => {
            logger.error({
              module: "scheduler",
              action: "task_sweep_failed",
              msg: "scheduler task pass failed",
              ...errorFields(err),
            });
          },
        ),
      ),
      this.runProducerPass("catalog", () =>
        retryTransient(() => this.reconcileCatalogDescribe(), {
          label: "catalog_describe",
        }).catch((err) => {
          logger.error({
            module: "scheduler",
            action: "catalog_describe_failed",
            msg: "scheduler catalog description pass failed",
            ...errorFields(err),
          });
        }),
      ),
    ];
    try {
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
      await retryTransient(() => this.reconcileScheduleHousekeeping(), {
        label: "schedule_housekeeping",
      }).catch((err) => {
        logger.error({
          module: "scheduler",
          action: "schedule_housekeeping_failed",
          msg: "scheduler approval-expiry notice and occurrence retention pass failed",
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
      await retryTransient(() => this.reconcileCockpitPushAttention(), {
        label: "cockpit_push_attention",
      }).catch((err) => {
        logger.error({
          module: "scheduler",
          action: "cockpit_push_attention_failed",
          msg: "scheduler cockpit push attention pass failed",
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
      await retryTransient(() => this.reconcileEverySchedules(), {
        label: "every_schedule_discovery",
      });
    } finally {
      await Promise.all(producerTasks);
    }
  }

  async reconcileEverySchedules(): Promise<void> {
    await this.everySweep.reconcile();
  }

  async reconcileDocsAutoRefresh(): Promise<void> {
    if (this.backgroundWork.deferred()) return;
    await instrument({
      module: "scheduler",
      action: "docs_auto_refresh.run",
      fn: () => this.reconcileDocsAutoRefreshPass(),
    });
  }

  private async reconcileDocsAutoRefreshPass(): Promise<void> {
    await runDocsRefreshSweep(this.opts.db, this.opts.boss);
  }

  async reconcileWorkflowSchedules(now: Date = new Date()): Promise<void> {
    await instrument({
      module: "scheduler",
      action: "workflow_schedules.run",
      fn: () => this.reconcileWorkflowSchedulesPass(now),
    });
  }

  private async reconcileWorkflowSchedulesPass(now: Date): Promise<void> {
    await runWorkflowCronSweep(this.opts.db, now, (key, payload, audit) =>
      this.fireWorkflowSchedule(key, payload, audit),
    );
  }

  async reconcileProactiveDriftScans(now: Date = new Date()): Promise<void> {
    if (this.backgroundWork.deferred()) return;
    await runTenantCadenceSweep("drift", now, this.opts.db, async (tenantId) => {
      try {
        await runProactiveDriftScanForTenant(tenantId, now, this.opts.db);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "drift_scan_failed",
          msg: "proactive drift scan threw for tenant — continuing with the rest",
          tenant_id: tenantId,
          ...errorFields(err),
        });
      }
    });
  }

  async reconcileConnectorReauthScans(now: Date = new Date()): Promise<void> {
    await runTenantCadenceSweep("reauth", now, this.opts.db, async (tenantId) => {
      try {
        await runConnectorReauthScanForTenant(tenantId, now, this.opts.db);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "connector_reauth_scan_failed",
          msg: "connector re-auth scan threw for tenant — continuing with the rest",
          tenant_id: tenantId,
          ...errorFields(err),
        });
      }
      try {
        await runOAuth2RefreshKeepAliveForTenant(tenantId, now, this.opts.db, this.opts.boss);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "oauth2_keepalive_failed",
          msg: "oauth2 refresh keep-alive sweep threw for tenant — continuing with the rest",
          tenant_id: tenantId,
          ...errorFields(err),
        });
      }
    });
  }

  async reconcilePersonalNotes(now: Date = new Date()): Promise<void> {
    if (this.backgroundWork.deferred()) return;
    await runTenantCadenceSweep("notes", now, this.opts.db, async (tenantId) => {
      try {
        await enqueuePersonalNotesForTenant(this.opts.db, this.opts.boss, tenantId);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "personal_notes_learn_failed",
          msg: "personal notes sweep threw for tenant — continuing with the rest",
          tenant_id: tenantId,
          ...errorFields(err),
        });
      }
    });
  }

  async reconcileEndpointContractScans(now: Date = new Date()): Promise<void> {
    if (this.backgroundWork.deferred()) return;
    await runTenantCadenceSweep("endpoint-contract", now, this.opts.db, async (tenantId) => {
      try {
        await runEndpointContractScanForTenant(tenantId, now, this.opts.db);
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "endpoint_contract_scan_failed",
          msg: "endpoint-contract scan threw for tenant — continuing with the rest",
          tenant_id: tenantId,
          ...errorFields(err),
        });
      }
    });
  }

  async reconcileSkillCandidateAnalysis(now: Date = new Date()): Promise<void> {
    if (this.backgroundWork.deferred()) return;
    await runSkillCandidateAnalysisSweep(now, this.opts.db, this.opts.boss);
  }

  async reconcileCatalogDescribe(): Promise<void> {
    if (this.backgroundWork.deferred()) return;
    await runCatalogDescribeSweep(this.opts.db, this.opts.boss);
  }

  async reconcileFilesCleanup(now: Date = new Date()): Promise<void> {
    if (this.lastFilesCleanupAt !== null) {
      const elapsed = now.getTime() - this.lastFilesCleanupAt.getTime();
      if (elapsed < FILES_CLEANUP_CADENCE_MS) return;
    }
    this.lastFilesCleanupAt = now;
    await runFilesCleanup(now, this.opts.db, this.opts.boss);
    await runTenantErasureSweep(this.opts.db, () => ({
      queue: this.opts.boss,
      objects: getObjectStore(),
    }));
  }

  async reconcileRiskSignalEdges(now: Date = new Date()): Promise<void> {
    if (this.lastRiskSignalEdgesAt !== null) {
      const elapsed = now.getTime() - this.lastRiskSignalEdgesAt.getTime();
      if (elapsed < RISK_SIGNAL_EDGE_CADENCE_MS) return;
    }
    await runRiskSignalEdges(this.opts.db);
    this.lastRiskSignalEdgesAt = now;
  }

  async reconcileCockpitPushAttention(now: Date = new Date()): Promise<void> {
    if (this.lastCockpitPushAttentionAt !== null) {
      const elapsed = now.getTime() - this.lastCockpitPushAttentionAt.getTime();
      if (elapsed < COCKPIT_PUSH_ATTENTION_CADENCE_MS) return;
    }
    this.lastCockpitPushAttentionAt = now;
    await (this.opts.cockpitPushAttentionRunner ?? runCockpitPushAttention)(this.opts.db, now);
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

  async reconcileScheduleHousekeeping(now: Date = new Date()): Promise<void> {
    if (this.lastScheduleHousekeepingAt !== null) {
      const elapsed = now.getTime() - this.lastScheduleHousekeepingAt.getTime();
      if (elapsed < NOTIFICATION_INBOX_RETENTION_CADENCE_MS) return;
    }
    this.lastScheduleHousekeepingAt = now;
    await runApprovalExpiryNotices(now, this.opts.db);
    await runScheduleOccurrenceRetention(now, this.opts.db);
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
      local: deviceConfirmationPort(this.opts.db),
      continue_after_local: async (step) => {
        const { continueTaskRunOfConversation } = await import("../tasks/run-driver.ts");
        await continueTaskRunOfConversation(this.opts.db, { ...step, now });
      },
    });
  }

  async reconcileEmbeddingBackfill(now: Date = new Date()): Promise<void> {
    if (this.backgroundWork.deferred()) return;
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
    if (this.backgroundWork.deferred()) return;
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
          sql`EXISTS (SELECT 1 FROM ${tenants} WHERE ${tenants.id} = ${connectors.tenant_id} AND ${tenants.status} = 'active' AND ${tenants.deleted_at} IS NULL)`,
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
          tenant_id: row.tenant_id,
          exec: this.opts.db,
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
  ): Promise<{ execution_id: string }> {
    return withContext(
      {
        audit_origin_source: "scheduler",
        audit_execution_source: "scheduler",
        audit_trace_id: crypto.randomUUID().replace(/-/g, ""),
      },
      () => this.fireWorkflowScheduleTrusted(key, payload, audit),
    );
  }

  private async fireWorkflowScheduleTrusted(
    key: string,
    payload: ExecutionRunJob,
    audit: {
      tenant_id: string;
      schedule_id: string;
      tz: string;
      occurrence_after: Date;
      claimed_at: Date;
    },
  ): Promise<{ execution_id: string }> {
    const admitted = await admitSystemWorkflowExecution(
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
      if (error instanceof Error && "code" in error && isAuthorityRefusalCode(error.code)) {
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
      await enqueueExecutionRun(this.opts.db, this.opts.boss, { ...job, execution_id });
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
    return { execution_id };
  }

  async reconcileKnowledgeAutoRefresh(): Promise<void> {
    if (this.backgroundWork.deferred()) return;
    await instrument({
      module: "scheduler",
      action: "knowledge_auto_refresh.run",
      fn: () => this.reconcileKnowledgeAutoRefreshPass(),
    });
  }

  private async reconcileKnowledgeAutoRefreshPass(): Promise<void> {
    await runKnowledgeRefreshSweep(this.opts.db, this.opts.boss);
  }
}
