import type { Queue, SendOptions } from "pg-boss";
import type { ChatEvent } from "../chat/types.ts";

export type QueueName =
  | "execution.run"
  | "execution.run.device"
  | "device.wait"
  | "conversation.run-turn"
  | "connector.refresh-oauth"
  | "connector.ingest-docs"
  | "knowledge.ingest"
  | "skill-candidate.analyze"
  | "catalog.describe"
  | "agent-session.analyze"
  | "workflow.repair"
  | "webhook.deliver"
  | "event.fanout"
  | "chat.event"
  | "task.run-turn";

export const QUEUE_NAMES: QueueName[] = [
  "execution.run",
  "execution.run.device",
  "device.wait",
  "conversation.run-turn",
  "connector.refresh-oauth",
  "connector.ingest-docs",
  "knowledge.ingest",
  "skill-candidate.analyze",
  "catalog.describe",
  "agent-session.analyze",
  "workflow.repair",
  "webhook.deliver",
  "event.fanout",
  "chat.event",
  "task.run-turn",
];

export interface QueueConfig {
  name: QueueName;
  queue: Omit<Queue, "name">;
  send?: SendOptions;
}

const EXECUTION_RUN_VISIBILITY_SECONDS = 10 * 60;
const CONVERSATION_RUN_TURN_VISIBILITY_SECONDS = 10 * 60;
const EXECUTION_RUN_DEVICE_VISIBILITY_SECONDS = 60 * 60;
const DEFAULT_RETENTION_SECONDS = 14 * 24 * 60 * 60;

const WEBHOOK_DELIVERY_RETRY_LIMIT = 11;

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
  "execution.run.device": {
    name: "execution.run.device",
    queue: {
      retryLimit: 0,
      expireInSeconds: EXECUTION_RUN_DEVICE_VISIBILITY_SECONDS,
      deadLetter: "execution.run.device.dlq",
      retentionSeconds: DEFAULT_RETENTION_SECONDS,
    },
  },
  "device.wait": {
    name: "device.wait",
    queue: {
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retentionSeconds: DEFAULT_RETENTION_SECONDS,
    },
  },
  "conversation.run-turn": {
    name: "conversation.run-turn",
    queue: {
      retryLimit: 0,
      expireInSeconds: CONVERSATION_RUN_TURN_VISIBILITY_SECONDS,
      deadLetter: "conversation.run-turn.dlq",
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
  "catalog.describe": {
    name: "catalog.describe",
    queue: {
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
    },
  },
  "agent-session.analyze": {
    name: "agent-session.analyze",
    queue: {
      retryLimit: 1,
      retryDelay: 60,
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
  "chat.event": {
    name: "chat.event",
    queue: {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 10 * 60,
      deadLetter: "chat.event.dlq",
      retentionSeconds: DEFAULT_RETENTION_SECONDS,
    },
  },
  "task.run-turn": {
    name: "task.run-turn",
    queue: {
      retryLimit: 0,
      expireInSeconds: CONVERSATION_RUN_TURN_VISIBILITY_SECONDS,
      deadLetter: "task.run-turn.dlq",
      retentionSeconds: DEFAULT_RETENTION_SECONDS,
    },
  },
};

export const EXECUTION_RUN_QUEUE: QueueName = "execution.run";
export const EXECUTION_RUN_DLQ: string = "execution.run.dlq";
export const EXECUTION_RUN_DEVICE_QUEUE: QueueName = "execution.run.device";
export const EXECUTION_RUN_DEVICE_DLQ: string = "execution.run.device.dlq";
export const DEVICE_WAIT_QUEUE: QueueName = "device.wait";

export type DeviceWaitJob =
  | { tenant_id: string; execution_id: string; phase: "attention" | "expire" }
  | { tenant_id: string; phase: "upload_expire" }
  | { tenant_id: string; phase: "screenshot_expire" };

export const CONVERSATION_RUN_TURN_QUEUE: QueueName = "conversation.run-turn";
export const CONVERSATION_RUN_TURN_DLQ: string = "conversation.run-turn.dlq";

export const CHAT_EVENT_QUEUE: QueueName = "chat.event";

export const TASK_RUN_TURN_QUEUE: QueueName = "task.run-turn";
export const TASK_RUN_TURN_DLQ: string = "task.run-turn.dlq";

export interface ChatEventJob {
  event: ChatEvent;
}

export interface ConversationRunTurnJob {
  turn_id?: string;
  tenant_id: string;
  conversation_id: string;
  mcp_task_id: string;
  attempt_id?: string;
  actor_id: string | null;
  principal?: import("../auth/types.ts").ResolvedPrincipal | null;
  kind: "start" | "append" | "respond_elicitation";
  provider_limit_parks?: number;
  elicitation_id?: string;
  answer_channel?: "model_relay" | "mcp_native" | "portal";
  approver_user_id?: string | null;
  reason?: string;
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
}

export interface ExecutionRunJob {
  tenant_id: string;
  workflow_id: string;
  execution_id?: string;
  input?: unknown;
  request_source?: string;
  parent_execution_id?: string | null;
  trace_id?: string | null;
  execution_mode?: "dev" | "prod";
  budget_resume?: boolean;
}
