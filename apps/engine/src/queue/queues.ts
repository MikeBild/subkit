// Queue definitions for the sk engine.
//
// Each entry declares a queue name plus the defaults pg-boss should use
// when creating the queue and when sending jobs into it. Every queue listed
// here MUST have a registered handler in `queue/handlers/index.ts`; pass-6
// of the cleanup audit removed seven dead declarations
// (`execution.notify`, `workflow.generate`, `schema.extract`, `chat.event`,
// `chat.deliver`, `conversation.tool-call`) that pg-boss
// was creating but nothing ever enqueued or consumed. Re-add as needed when
// the consumer ships.

import type { Queue, SendOptions } from "pg-boss";

export type QueueName =
  | "execution.run"
  | "connector.refresh-oauth"
  | "connector.ingest-docs"
  | "knowledge.ingest"
  | "skill-candidate.analyze"
  | "workflow.repair"
  | "webhook.deliver"
  | "event.fanout";

export const QUEUE_NAMES: QueueName[] = [
  "execution.run",
  "connector.refresh-oauth",
  "connector.ingest-docs",
  "knowledge.ingest",
  "skill-candidate.analyze",
  "workflow.repair",
  "webhook.deliver",
  "event.fanout",
];

export interface QueueConfig {
  name: QueueName;
  queue: Omit<Queue, "name">;
  /** Per-send defaults layered on top of the queue create options. */
  send?: SendOptions;
}

const EXECUTION_RUN_VISIBILITY_SECONDS = 10 * 60;
const DEFAULT_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * webhook.deliver wants an explicit retry schedule: 1m, 5m, 30m, 2h, 5h,
 * 10h, then every 12h up to 3 days. pg-boss itself exposes a single
 * `retryDelay` + `retryBackoff` knob; the explicit schedule is enforced
 * by the webhook consumer (`queue/handlers/webhook-deliver.ts`) computing
 * the next delay from retry_count and enqueueing a `sendAfter`. We still
 * preload the limit here so the queue create call creates the queue.
 */
const WEBHOOK_DELIVERY_RETRY_LIMIT = 11; // 1m,5m,30m,2h,5h,10h + 5×12h

export const QUEUE_DEFINITIONS: Record<QueueName, QueueConfig> = {
  "execution.run": {
    name: "execution.run",
    queue: {
      retryLimit: 5,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: EXECUTION_RUN_VISIBILITY_SECONDS,
      deadLetter: "execution.run.dlq",
      retentionSeconds: DEFAULT_RETENTION_SECONDS,
    },
  },
  "connector.refresh-oauth": {
    name: "connector.refresh-oauth",
    queue: {
      retryLimit: 5,
      retryDelay: 10,
      retryBackoff: true,
      retryDelayMax: 300,
    },
  },
  "connector.ingest-docs": {
    name: "connector.ingest-docs",
    queue: {
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    },
  },
  "knowledge.ingest": {
    name: "knowledge.ingest",
    queue: {
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    },
  },
  "skill-candidate.analyze": {
    name: "skill-candidate.analyze",
    queue: {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
    },
  },
  "workflow.repair": {
    name: "workflow.repair",
    queue: {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
    },
  },
  "webhook.deliver": {
    name: "webhook.deliver",
    queue: {
      retryLimit: WEBHOOK_DELIVERY_RETRY_LIMIT,
      retryDelay: 60,
      retryBackoff: false,
      expireInSeconds: 5 * 60,
      retentionSeconds: 3 * 24 * 60 * 60,
    },
  },
  "event.fanout": {
    name: "event.fanout",
    queue: {
      retryLimit: 3,
      retryDelay: 2,
      retryBackoff: true,
    },
  },
};

export const EXECUTION_RUN_QUEUE: QueueName = "execution.run";
export const EXECUTION_RUN_DLQ: string = "execution.run.dlq";

/**
 * Envelope that execution.run jobs carry. Fields are kept small enough to
 * fit well under pg-boss' 8 KB payload cap.
 */
export interface ExecutionRunJob {
  tenant_id: string;
  workflow_id: string;
  execution_id?: string;
  input?: unknown;
  request_source?: string;
  parent_execution_id?: string | null;
  trace_id?: string | null;
  execution_mode?: "dev" | "prod";
}
