import type { Job, PgBoss } from "pg-boss";
import { analyzeAgentSession } from "../../agent/index.ts";
import type { Actor } from "../../audit/actor.ts";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/index.ts";
import { withActiveTenantJobContext } from "../job-context.ts";

export const AGENT_SESSION_ANALYZE_QUEUE = "agent-session.analyze" as const;

export interface AgentSessionAnalyzeJob {
  tenant_id: string;
  agent: string;
  session_id?: string;
  repo?: string;
  domains: string[];
  transcript: string;
  actor?: Actor | null;
}

interface RegisterAgentSessionAnalyzeOptions {
  boss: PgBoss;
  db: Db;
}

export async function processAgentSessionAnalyzeJob(
  job: Job<AgentSessionAnalyzeJob>,
  db: Db,
): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
    msg: "agent-session.analyze job dequeued",
    queue: AGENT_SESSION_ANALYZE_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    agent: data.agent,
    session_id: data.session_id ?? null,
  });
  const started = Date.now();
  try {
    const result = await analyzeAgentSession({
      tenant_id: data.tenant_id,
      transcript: data.transcript,
      meta: {
        agent: data.agent,
        ...(data.session_id ? { session_id: data.session_id } : {}),
        ...(data.repo ? { repo: data.repo } : {}),
        domains: data.domains,
      },
      actor: data.actor ?? null,
      db,
    });
    log.queue.job.completed({
      msg: "agent-session.analyze job completed",
      queue: AGENT_SESSION_ANALYZE_QUEUE,
      job_id: job.id,
      learnings_found: result.learnings_found,
      collected: result.collected,
      evidence_appended: result.evidence_appended,
      replayed: result.replayed,
      dropped: result.dropped,
      not_collected: result.not_collected,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    log.queue.job.failed({
      msg: "agent-session.analyze job failed",
      queue: AGENT_SESSION_ANALYZE_QUEUE,
      job_id: job.id,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerAgentSessionAnalyzeHandler(
  opts: RegisterAgentSessionAnalyzeOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<AgentSessionAnalyzeJob>(
    AGENT_SESSION_ANALYZE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<AgentSessionAnalyzeJob>[]) => {
      for (const job of jobs) {
        await withActiveTenantJobContext(job.data, db, () =>
          processAgentSessionAnalyzeJob(job, db),
        );
      }
    },
  );
  log.queue.worker.registered({
    msg: "agent-session.analyze worker registered",
    worker_id: workerId,
    queue: AGENT_SESSION_ANALYZE_QUEUE,
  });
  return workerId;
}
