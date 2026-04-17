// Register all queue handlers against a running PgBoss instance.

import type { PgBoss } from "pg-boss";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import { registerOAuth2RefreshHandler } from "../../credentials/oauth2/refresh-worker.ts";
import type { Db } from "../../db/client.ts";
import { registerApiKeyFlushHandler } from "./apikey-flush.ts";
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
  apikeyFlushWorkerId: string;
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
  const apikeyFlushWorkerId = await registerApiKeyFlushHandler(opts.boss);
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
  return {
    executionRunWorkerId,
    apikeyFlushWorkerId,
    oauth2RefreshWorkerId,
    ingestDocsWorkerId,
    ingestKnowledgeWorkerId,
    skillCandidateAnalyzeWorkerId,
    workflowRepairWorkerId,
    webhookDeliverWorkerId,
    eventFanoutWorkerId,
  };
}
