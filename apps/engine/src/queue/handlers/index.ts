// Register all queue handlers against a running PgBoss instance.

import type { PgBoss } from "pg-boss";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import { registerOAuth2RefreshHandler } from "../../credentials/oauth2/refresh-worker.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { registerConversationRunTurnHandler } from "./conversation-run-turn.ts";
import { registerConversationRunTurnDlqHandler } from "./conversation-run-turn-dlq.ts";
import { registerEventFanoutHandler } from "./event-fanout.ts";
import { registerExecutionRunHandler } from "./execution-run.ts";
import { registerIngestDocsHandler } from "./ingest-docs.ts";
import { registerIngestKnowledgeHandler } from "./ingest-knowledge.ts";
import { registerSkillCandidateAnalyzeHandler } from "./skill-candidate-analyze.ts";
import { registerWebhookDeliverHandler } from "./webhook-deliver.ts";
import { registerWorkflowRepairHandler } from "./workflow-repair.ts";

export interface RegisterHandlersOptions {
  boss: PgBoss;
  db: Db;
  /** Optional chat adapter registry, threaded into the fanout worker so
   * notification rules can dispatch through registered chat adapters. */
  chatRegistry?: ChatAdapterRegistry;
}

export interface RegisteredHandlers {
  executionRunWorkerId: string;
  conversationRunTurnWorkerId: string;
  conversationRunTurnDlqWorkerId: string;
  oauth2RefreshWorkerId: string;
  ingestDocsWorkerId: string;
  ingestKnowledgeWorkerId: string;
  skillCandidateAnalyzeWorkerId: string;
  workflowRepairWorkerId: string;
  webhookDeliverWorkerId: string | null;
  eventFanoutWorkerId: string;
}

export async function registerAllHandlers(
  opts: RegisterHandlersOptions,
): Promise<RegisteredHandlers> {
  const executionRunWorkerId = await registerExecutionRunHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const conversationRunTurnWorkerId = await registerConversationRunTurnHandler({
    boss: opts.boss,
    db: opts.db,
  });
  // DLQ consumer — reconciles `mcp_tasks` rows stranded `working` when
  // the run-turn worker process died mid-turn (the turn's own `catch`
  // never ran). Without this an OOM restart leaves a forever-polling
  // task. See conversation-run-turn-dlq.ts.
  const conversationRunTurnDlqWorkerId = await registerConversationRunTurnDlqHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const oauth2RefreshWorkerId = await registerOAuth2RefreshHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const ingestDocsWorkerId = await registerIngestDocsHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const ingestKnowledgeWorkerId = await registerIngestKnowledgeHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const skillCandidateAnalyzeWorkerId = await registerSkillCandidateAnalyzeHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const workflowRepairWorkerId = await registerWorkflowRepairHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const webhookDeliverWorkerId = await registerWebhookDeliverHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const eventFanoutWorkerId = await registerEventFanoutHandler({
    boss: opts.boss,
    db: opts.db,
    ...(opts.chatRegistry ? { chatRegistry: opts.chatRegistry } : {}),
  });
  // Boot summary — single line operators can grep for to confirm the
  // queue layer is fully up. Each handler also emits its own
  // `<queue>.registered` line above; this is the aggregate signal.
  logger.info({
    module: "queue",
    action: "handlers.registered",
    msg: "all queue handlers registered",
    execution_run_worker_id: executionRunWorkerId,
    conversation_run_turn_worker_id: conversationRunTurnWorkerId,
    conversation_run_turn_dlq_worker_id: conversationRunTurnDlqWorkerId,
    oauth2_refresh_worker_id: oauth2RefreshWorkerId,
    ingest_docs_worker_id: ingestDocsWorkerId,
    ingest_knowledge_worker_id: ingestKnowledgeWorkerId,
    skill_candidate_analyze_worker_id: skillCandidateAnalyzeWorkerId,
    workflow_repair_worker_id: workflowRepairWorkerId,
    webhook_deliver_worker_id: webhookDeliverWorkerId,
    event_fanout_worker_id: eventFanoutWorkerId,
    chat_registry: opts.chatRegistry ? "present" : "absent",
  });
  return {
    executionRunWorkerId,
    conversationRunTurnWorkerId,
    conversationRunTurnDlqWorkerId,
    oauth2RefreshWorkerId,
    ingestDocsWorkerId,
    ingestKnowledgeWorkerId,
    skillCandidateAnalyzeWorkerId,
    workflowRepairWorkerId,
    webhookDeliverWorkerId,
    eventFanoutWorkerId,
  };
}
