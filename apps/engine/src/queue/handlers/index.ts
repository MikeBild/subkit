import type { PgBoss } from "pg-boss";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import { registerOAuth2RefreshHandler } from "../../credentials/oauth2/refresh-worker.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { registerAgentSessionAnalyzeHandler } from "./agent-session-analyze.ts";
import { registerCatalogDescribeHandler } from "./catalog-describe.ts";
import { registerChatEventHandler } from "./chat-event.ts";
import { registerConversationRunTurnHandler } from "./conversation-run-turn.ts";
import { registerConversationRunTurnDlqHandler } from "./conversation-run-turn-dlq.ts";
import { registerDeviceRunHandlers } from "./device-run.ts";
import { registerEventFanoutHandler } from "./event-fanout.ts";
import { registerExecutionRunHandler } from "./execution-run.ts";
import { registerIngestDocsHandler } from "./ingest-docs.ts";
import { registerIngestKnowledgeHandler } from "./ingest-knowledge.ts";
import { registerPersonalNotesLearnHandler } from "./personal-notes-learn.ts";
import { registerSkillCandidateAnalyzeHandler } from "./skill-candidate-analyze.ts";
import { registerTaskRunTurnHandler } from "./task-run-turn.ts";
import { registerTaskRunTurnDlqHandler } from "./task-run-turn-dlq.ts";
import { registerWebhookDeliverHandler } from "./webhook-deliver.ts";
import { registerWorkflowRepairHandler } from "./workflow-repair.ts";

interface RegisterHandlersOptions {
  boss: PgBoss;
  db: Db;
  chatRegistry?: ChatAdapterRegistry;
}

interface RegisteredHandlers {
  executionRunWorkerId: string;
  deviceRunWorkerIds: Awaited<ReturnType<typeof registerDeviceRunHandlers>>;
  conversationRunTurnWorkerId: string;
  conversationRunTurnDlqWorkerId: string;
  taskRunTurnWorkerId: string;
  taskRunTurnDlqWorkerId: string;
  oauth2RefreshWorkerId: string;
  ingestDocsWorkerId: string;
  ingestKnowledgeWorkerId: string;
  skillCandidateAnalyzeWorkerId: string;
  personalNotesLearnWorkerId: string;
  catalogDescribeWorkerId: string;
  agentSessionAnalyzeWorkerId: string;
  workflowRepairWorkerId: string;
  webhookDeliverWorkerId: string | null;
  eventFanoutWorkerId: string;
  chatEventWorkerId: string | null;
}

export async function registerAllHandlers(
  opts: RegisterHandlersOptions,
): Promise<RegisteredHandlers> {
  const executionRunWorkerId = await registerExecutionRunHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const deviceRunWorkerIds = await registerDeviceRunHandlers({ boss: opts.boss, db: opts.db });
  const conversationRunTurnWorkerId = await registerConversationRunTurnHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const conversationRunTurnDlqWorkerId = await registerConversationRunTurnDlqHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const taskRunTurnWorkerId = await registerTaskRunTurnHandler({ boss: opts.boss, db: opts.db });
  const taskRunTurnDlqWorkerId = await registerTaskRunTurnDlqHandler({
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
  const personalNotesLearnWorkerId = await registerPersonalNotesLearnHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const catalogDescribeWorkerId = await registerCatalogDescribeHandler({
    boss: opts.boss,
    db: opts.db,
  });
  const agentSessionAnalyzeWorkerId = await registerAgentSessionAnalyzeHandler({
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
  const chatEventWorkerId = opts.chatRegistry
    ? await registerChatEventHandler({
        boss: opts.boss,
        db: opts.db,
        chatRegistry: opts.chatRegistry,
      })
    : null;
  logger.info({
    module: "queue",
    action: "handlers.registered",
    msg: "all queue handlers registered",
    execution_run_worker_id: executionRunWorkerId,
    device_run_worker_id: deviceRunWorkerIds.run,
    conversation_run_turn_worker_id: conversationRunTurnWorkerId,
    conversation_run_turn_dlq_worker_id: conversationRunTurnDlqWorkerId,
    task_run_turn_worker_id: taskRunTurnWorkerId,
    task_run_turn_dlq_worker_id: taskRunTurnDlqWorkerId,
    oauth2_refresh_worker_id: oauth2RefreshWorkerId,
    ingest_docs_worker_id: ingestDocsWorkerId,
    ingest_knowledge_worker_id: ingestKnowledgeWorkerId,
    skill_candidate_analyze_worker_id: skillCandidateAnalyzeWorkerId,
    personal_notes_learn_worker_id: personalNotesLearnWorkerId,
    catalog_describe_worker_id: catalogDescribeWorkerId,
    agent_session_analyze_worker_id: agentSessionAnalyzeWorkerId,
    workflow_repair_worker_id: workflowRepairWorkerId,
    webhook_deliver_worker_id: webhookDeliverWorkerId,
    event_fanout_worker_id: eventFanoutWorkerId,
    chat_event_worker_id: chatEventWorkerId,
    chat_registry: opts.chatRegistry ? "present" : "absent",
  });
  return {
    executionRunWorkerId,
    deviceRunWorkerIds,
    conversationRunTurnWorkerId,
    conversationRunTurnDlqWorkerId,
    taskRunTurnWorkerId,
    taskRunTurnDlqWorkerId,
    oauth2RefreshWorkerId,
    ingestDocsWorkerId,
    ingestKnowledgeWorkerId,
    skillCandidateAnalyzeWorkerId,
    personalNotesLearnWorkerId,
    catalogDescribeWorkerId,
    agentSessionAnalyzeWorkerId,
    workflowRepairWorkerId,
    webhookDeliverWorkerId,
    eventFanoutWorkerId,
    chatEventWorkerId,
  };
}
