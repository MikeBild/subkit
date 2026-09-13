// Queue definitions for the sk engine.
//
// Each entry declares a queue name plus the defaults pg-boss should use
// when creating the queue and when sending jobs into it. Every queue listed
// here MUST have a registered handler in `queue/handlers/index.ts`. Past
// cleanup passes have removed several dead declarations (e.g.
// `execution.notify`, `workflow.generate`, `schema.extract`,
// `chat.deliver`, `conversation.tool-call`) that pg-boss was creating but
// nothing ever enqueued or consumed. Re-add as needed when the consumer ships.
//
// `chat.event` is re-added here as part of activating the chat-bridge
// subsystem: the HTTP ingestion route at `/v1/chat/<platform>/*` enqueues
// one job per verified inbound event so the dispatcher (an agentic
// conversation turn that can take minutes) runs out-of-band. Slack requires
// a <3 s ack on Events API posts, which the queue ack satisfies.

import type { Queue, SendOptions } from "pg-boss";

import type { ChatEvent } from "../chat/types.ts";

export type QueueName =
  | "execution.run"
  | "conversation.run-turn"
  | "connector.refresh-oauth"
  | "connector.ingest-docs"
  | "knowledge.ingest"
  | "skill-candidate.analyze"
  | "agent-session.analyze"
  | "workflow.repair"
  | "webhook.deliver"
  | "event.fanout"
  | "chat.event";

export const QUEUE_NAMES: QueueName[] = [
  "execution.run",
  "conversation.run-turn",
  "connector.refresh-oauth",
  "connector.ingest-docs",
  "knowledge.ingest",
  "skill-candidate.analyze",
  "agent-session.analyze",
  "workflow.repair",
  "webhook.deliver",
  "event.fanout",
  "chat.event",
];

export interface QueueConfig {
  name: QueueName;
  queue: Omit<Queue, "name">;
  /** Per-send defaults layered on top of the queue create options. */
  send?: SendOptions;
}

const EXECUTION_RUN_VISIBILITY_SECONDS = 10 * 60;
const CONVERSATION_RUN_TURN_VISIBILITY_SECONDS = 10 * 60;
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
  // A backgrounded MCP conversation turn. retryLimit:0 — a turn makes
  // real, non-idempotent LLM + external calls; replaying it would
  // double-charge tokens and re-fire side effects. A turn that throws
  // lands in the DLQ for inspection and the `mcp_tasks` row is marked
  // `failed` by the worker's catch.
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
  // Transcript distillation makes one LLM extract call; a retry re-spends
  // tokens but fingerprint dedup makes the outcome idempotent, so a single
  // retry covers transient provider errors without doubling cost twice.
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
  // Chat-bridge ingestion → dispatcher. Turns can take minutes (full
  // agentic loop), so visibility is generous; retries are bounded —
  // a duplicate inbound is suppressed by `chat/dedup.ts` keyed on the
  // platform-native event id (`event_id` / `view.id` / hash of slash
  // command). Dead-letter captures terminal failures for inspection.
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
};

export const EXECUTION_RUN_QUEUE: QueueName = "execution.run";
export const EXECUTION_RUN_DLQ: string = "execution.run.dlq";

export const CONVERSATION_RUN_TURN_QUEUE: QueueName = "conversation.run-turn";
export const CONVERSATION_RUN_TURN_DLQ: string = "conversation.run-turn.dlq";

export const CHAT_EVENT_QUEUE: QueueName = "chat.event";
export const CHAT_EVENT_DLQ: string = "chat.event.dlq";

/**
 * Envelope a `chat.event` job carries. A whole `ChatEvent` is small (a
 * handful of ids + the message text or interaction payload), well under
 * pg-boss' 8 KB cap. We carry the full event inline so the worker does
 * not need a separate persistence hop just to round-trip the payload —
 * unlike `conversation.run-turn`, an `ask_user_form` answer never rides
 * inside a `ChatEvent` (the form submission is delivered separately as
 * its own interaction event).
 */
export interface ChatEventJob {
  event: ChatEvent;
}

/**
 * Envelope a `conversation.run-turn` job carries. TINY by design — only
 * ids, well under pg-boss' 8 KB cap. No payload body travels here:
 *  - the user message body is persisted to `conversation_messages`
 *    before enqueue; the worker reads it back by the
 *    `mcp_tasks.user_message_id` the handler pinned,
 *  - a `respond_elicitation` answer is persisted to
 *    `conversation_elicitations.output` before enqueue; the worker
 *    reads it back by `elicitation_id`. An `ask_user_form` answer can
 *    exceed pg-boss' 8 KB cap, so it must never ride inline.
 * `mcp_task_id` correlates the job to its `mcp_tasks` index row.
 */
export interface ConversationRunTurnJob {
  tenant_id: string;
  conversation_id: string;
  mcp_task_id: string;
  /**
   * Fences this queue attempt against a later resume that deliberately
   * reuses the same MCP task id. It is also the pg-boss job id. A resumed
   * native elicitation replaces `mcp_tasks.job_id` before enqueueing, so the
   * worker from the pausing turn cannot publish a stale terminal result over
   * the resumed turn.
   *
   * Optional only for jobs written before this fence and for low-level tests
   * that enqueue a legacy-shaped envelope directly.
   */
  attempt_id?: string;
  actor_id: string | null;
  /**
   * Resolved principal of the actor who initiated the turn. The HTTP/SSE
   * surface threads its live principal straight into `runConversationTurn`;
   * the MCP async path runs the turn in a queue worker that has no live
   * request, so the principal must ride the job envelope or RBAC-gated
   * tools (notably `run_workflow`) fail with `principal_required`. Always
   * the initiating actor's OWN principal (same tenant_id as this job) —
   * never elevated. Small + JSON-serialisable; well under the 8 KB cap.
   */
  principal?: import("../auth/types.ts").ResolvedPrincipal | null;
  kind: "start" | "append" | "respond_elicitation";
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  /**
   * How many times this turn has been parked-and-re-enqueued after a
   * provider quota/rate-limit error (see
   * `queue/handlers/provider-limit-park.ts`). Bounded by
   * `PROVIDER_LIMIT_PARK_MAX`; absent means zero.
   */
  provider_limit_parks?: number;
  /** Present only for `respond_elicitation` turns. */
  elicitation_id?: string;
  /** Server-authored provenance. MCP tool arguments can never set this.
   *  `portal` = a human decided in the browser approval portal, which granted
   *  the `tool_approvals` row inside their own request before enqueueing this
   *  turn. */
  answer_channel?: "model_relay" | "mcp_native" | "portal";
  /** The person the portal identified as the approver, for `answer_channel:
   *  "portal"`. Null when the unauthenticated portal could not identify them —
   *  the resume then attributes no human rather than inventing one. */
  approver_user_id?: string | null;
  reason?: string;
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
}

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
