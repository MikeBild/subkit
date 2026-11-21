import { z } from "@hono/zod-openapi";
import type { Executor } from "../../db/client.ts";
import { writeEvent } from "../../db/events.ts";
import { logger } from "../../logging/index.ts";
import {
  ConnectorAuthFailedPayloadSchema,
  ConnectorHealthChangedPayloadSchema,
  ConnectorOauthCallbackFailedPayloadSchema,
  ConnectorOauthCallbackPayloadSchema,
  ConnectorSignInFinishedPayloadSchema,
} from "../../pubsub/index.ts";
import {
  ScheduleAutoPausedPayloadSchema,
  TaskGrantExpiringPayloadSchema,
  WorkflowApprovalExpiringPayloadSchema,
} from "./schedule-events.ts";

const ExecutionSucceeded = z.object({
  execution_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  duration_ms: z.number().int().nonnegative(),
  output_preview: z.unknown().optional(),
});

const ExecutionFailed = z.object({
  execution_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  error: z.string(),
  error_code: z.string().optional(),
});

const ExecutionRefused = z.object({
  execution_id: z.string().uuid(),
  workflow_id: z.string().uuid().nullable(),
  failure: z.object({
    step_id: z.string().nullable(),
    error_code: z.string(),
    error_message: z.string(),
    connector: z.object({ connector_id: z.string().nullable(), reason: z.string() }).optional(),
  }),
});

const WorkflowUpdated = z.object({
  workflow_id: z.string().uuid(),
  version: z.number().int().positive(),
  updated_by: z.string().uuid().nullable().optional(),
});

const ConnectorOAuthRefreshed = z.object({
  connector_id: z.string().uuid(),
  credential_id: z.string().uuid(),
  environment: z.enum(["dev", "prod"]),
  expires_at: z.string().nullable().optional(),
});

const PatchProposed = z.object({
  patch_candidate_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  classification: z.enum(["safe", "unsafe"]),
});

const PatchApplied = z.object({
  patch_candidate_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  workflow_version_id: z.string().uuid(),
  changed_paths: z.array(z.string()),
  auto_applied: z.boolean(),
});

const ApiKeyRotated = z.object({
  api_key_id: z.string().uuid(),
  actor_id: z.string().uuid().nullable(),
});

const ConversationCommitted = z.object({
  conversation_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
});

const TaskRunReasonCode = z.string().regex(/^[a-z0-9_.:-]{1,200}$/);

const TaskRunStarted = z.object({
  task_run_id: z.string().uuid(),
  task_id: z.string().uuid(),
  trigger: z.enum(["manual", "once", "cron"]),
  environment: z.enum(["dev", "prod"]),
});

const TaskRunWaiting = z.object({
  task_run_id: z.string().uuid(),
  task_id: z.string().uuid(),
  trigger: z.enum(["manual", "once", "cron"]),
  waiting_reason: z.enum([
    "question",
    "approval",
    "no_progress",
    "budget",
    "question_expired",
    "ai_access",
    "turn_stopped",
  ]),
});

const TaskRunResultReady = z.object({
  task_run_id: z.string().uuid(),
  task_id: z.string().uuid(),
  trigger: z.enum(["manual", "once", "cron"]),
  turns_used: z.number().int().nonnegative(),
});

const TaskRunCompleted = z.object({
  task_run_id: z.string().uuid(),
  task_id: z.string().uuid(),
  trigger: z.enum(["manual", "once", "cron"]),
  turns_used: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
});

const TaskRunFailed = z.object({
  task_run_id: z.string().uuid(),
  task_id: z.string().uuid(),
  trigger: z.enum(["manual", "once", "cron"]),
  failure_code: TaskRunReasonCode.nullable(),
});

const TASK_RUN_EVENT_SCHEMAS = {
  "task_run.started": TaskRunStarted,
  "task_run.waiting": TaskRunWaiting,
  "task_run.result_ready": TaskRunResultReady,
  "task_run.completed": TaskRunCompleted,
  "task_run.failed": TaskRunFailed,
} as const;

export type TaskRunEventType = keyof typeof TASK_RUN_EVENT_SCHEMAS;

export type TaskRunEventPayload<T extends TaskRunEventType> = z.input<
  (typeof TASK_RUN_EVENT_SCHEMAS)[T]
>;

export async function emitTaskRunEvent<T extends TaskRunEventType>(
  tx: Executor,
  tenant_id: string,
  type: T,
  payload: TaskRunEventPayload<T>,
): Promise<boolean> {
  const schema: z.ZodTypeAny = TASK_RUN_EVENT_SCHEMAS[type];
  const candidate: Record<string, unknown> = { ...payload };
  if (
    type === "task_run.failed" &&
    !TaskRunReasonCode.nullable().safeParse(candidate.failure_code).success
  ) {
    candidate.failure_code = null;
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    logger.warn({
      module: "webhooks.events",
      action: "task_run_event.skipped",
      msg: "task run event failed its catalog schema and was not emitted",
      tenant_id,
      event_type: type,
      invalid_fields: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
    return false;
  }
  await writeEvent(tx, {
    tenant_id,
    channel: "notification.emitted",
    type,
    payload: parsed.data as Record<string, unknown>,
  });
  return true;
}

type ActionablePredicate = (payload: unknown) => boolean;

type ResourceExtractor = (payload: unknown) => { type: string; id: string } | null;

export interface EventCatalogEntry {
  name: string;
  schema: z.ZodTypeAny;
  example: unknown;
  actionable: ActionablePredicate;
  resource: ResourceExtractor;
}

const ACTIONABLE: ActionablePredicate = () => true;
const NOT_ACTIONABLE: ActionablePredicate = () => false;

function readField(payload: unknown, key: string): unknown {
  if (payload === null || typeof payload !== "object") return undefined;
  return (payload as Record<string, unknown>)[key];
}

function pointsAt(resource_type: string, id_key: string): ResourceExtractor {
  return (payload) => {
    const id = readField(payload, id_key);
    return typeof id === "string" && id.length > 0 ? { type: resource_type, id } : null;
  };
}

export const EVENT_CATALOG = {
  "execution.succeeded": {
    name: "execution.succeeded",
    schema: ExecutionSucceeded,
    example: {
      execution_id: "00000000-0000-4000-8000-000000000001",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      duration_ms: 1234,
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("execution", "execution_id"),
  },
  "execution.failed": {
    name: "execution.failed",
    schema: ExecutionFailed,
    example: {
      execution_id: "00000000-0000-4000-8000-000000000001",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      error: "step invoice.fetch failed: timeout",
    },
    actionable: ACTIONABLE,
    resource: pointsAt("execution", "execution_id"),
  },
  "execution.refused": {
    name: "execution.refused",
    schema: ExecutionRefused,
    example: {
      execution_id: "00000000-0000-4000-8000-000000000001",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      failure: {
        step_id: "send",
        error_code: "prepared_credential_unavailable",
        error_message: 'Connector "gmail" in dev must be reconnected before this workflow can run.',
        connector: { connector_id: "00000000-0000-4000-8000-000000000003", reason: "needs_reauth" },
      },
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("execution", "execution_id"),
  },
  "workflow.updated": {
    name: "workflow.updated",
    schema: WorkflowUpdated,
    example: {
      workflow_id: "00000000-0000-4000-8000-000000000002",
      version: 7,
      updated_by: null,
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("workflow", "workflow_id"),
  },
  "connector.oauth.refreshed": {
    name: "connector.oauth.refreshed",
    schema: ConnectorOAuthRefreshed,
    example: {
      connector_id: "00000000-0000-4000-8000-000000000003",
      credential_id: "00000000-0000-4000-8000-000000000004",
      environment: "prod",
      expires_at: "2026-05-01T00:00:00.000Z",
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("connector", "connector_id"),
  },
  "connector.oauth.callback_succeeded": {
    name: "connector.oauth.callback_succeeded",
    schema: ConnectorOauthCallbackPayloadSchema,
    example: {
      connector_id: "00000000-0000-4000-8000-000000000003",
      connector_slug: "google-gmail",
      has_refresh_token: true,
      source: "oauth_callback",
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("connector", "connector_id"),
  },
  "connector.oauth.callback_failed": {
    name: "connector.oauth.callback_failed",
    schema: ConnectorOauthCallbackFailedPayloadSchema,
    example: {
      connector_id: "00000000-0000-4000-8000-000000000003",
      connector_slug: "google-gmail",
      reason: "provider_error",
    },
    actionable: ACTIONABLE,
    resource: pointsAt("connector", "connector_id"),
  },
  "connector.oauth.signin_finished": {
    name: "connector.oauth.signin_finished",
    schema: ConnectorSignInFinishedPayloadSchema,
    example: {
      connector_id: "00000000-0000-4000-8000-000000000003",
      connector_slug: "google-gmail",
      outcome: "succeeded",
      reason: null,
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("connector", "connector_id"),
  },
  "connector.auth_failed": {
    name: "connector.auth_failed",
    schema: ConnectorAuthFailedPayloadSchema,
    example: {
      severity: "error",
      workflow_id: null,
      connector_id: "00000000-0000-4000-8000-000000000003",
      connector_slug: "google-gmail",
      reason: "credential_rejected",
      reauth_url:
        "https://engine.example.com/v1/connectors/00000000-0000-4000-8000-000000000003/oauth/start",
    },
    actionable: ACTIONABLE,
    resource: pointsAt("connector", "connector_id"),
  },
  "connector.health_changed": {
    name: "connector.health_changed",
    schema: ConnectorHealthChangedPayloadSchema,
    example: {
      severity: "error",
      workflow_id: null,
      connector_id: "00000000-0000-4000-8000-000000000003",
      connector_slug: "google-gmail",
      from_state: "ok",
      to_state: "needs_update",
      error_code: "endpoint_removed",
      reason: "endpoint returned 410 Gone",
      sunset_at: null,
      successor_uri: null,
    },
    actionable: (payload) => readField(payload, "error_code") === "endpoint_removed",
    resource: pointsAt("connector", "connector_id"),
  },
  "patch.proposed": {
    name: "patch.proposed",
    schema: PatchProposed,
    example: {
      patch_candidate_id: "00000000-0000-4000-8000-000000000005",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      classification: "safe",
    },
    actionable: ACTIONABLE,
    resource: pointsAt("patch_candidate", "patch_candidate_id"),
  },
  "patch.applied": {
    name: "patch.applied",
    schema: PatchApplied,
    example: {
      patch_candidate_id: "00000000-0000-4000-8000-000000000005",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      workflow_version_id: "00000000-0000-4000-8000-000000000007",
      changed_paths: ["data_selector"],
      auto_applied: true,
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("workflow", "workflow_id"),
  },
  "apikey.rotated": {
    name: "apikey.rotated",
    schema: ApiKeyRotated,
    example: {
      api_key_id: "00000000-0000-4000-8000-000000000006",
      actor_id: null,
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("api_key", "api_key_id"),
  },
  "conversation.committed": {
    name: "conversation.committed",
    schema: ConversationCommitted,
    example: {
      conversation_id: "00000000-0000-4000-8000-000000000008",
      workflow_id: "00000000-0000-4000-8000-000000000002",
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("conversation", "conversation_id"),
  },
  "schedule.auto_paused": {
    name: "schedule.auto_paused",
    schema: ScheduleAutoPausedPayloadSchema,
    example: {
      severity: "error",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      workflow_name: "Mail outbox",
      schedule_id: "00000000-0000-4000-8000-000000000009",
      environment: "prod",
      paused_reason: "repeated_failures",
      failure_class: "sensitive_execution_failure",
      consecutive_failures: 5,
      paused_at: "2026-11-20T08:00:00.000Z",
      remedy: {
        kind: "resume",
        href: "/cockpit/workflows/00000000-0000-4000-8000-000000000002#workflow-automation",
      },
    },
    actionable: ACTIONABLE,
    resource: pointsAt("workflow", "workflow_id"),
  },
  "workflow.approval_expiring": {
    name: "workflow.approval_expiring",
    schema: WorkflowApprovalExpiringPayloadSchema,
    example: {
      severity: "warn",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      workflow_name: "Mail outbox",
      authority_id: "00000000-0000-4000-8000-00000000000a",
      environment: "prod",
      valid_until: "2026-11-23T08:00:00.000Z",
      remedy: {
        kind: "renew",
        href: "/cockpit/workflows/00000000-0000-4000-8000-000000000002#workflow-automation",
      },
    },
    actionable: ACTIONABLE,
    resource: pointsAt("workflow", "workflow_id"),
  },
  "task.grant_expiring": {
    name: "task.grant_expiring",
    schema: TaskGrantExpiringPayloadSchema,
    example: {
      severity: "warn",
      task_id: "00000000-0000-4000-8000-00000000000b",
      task_name: "Weekly report",
      grant_id: "00000000-0000-4000-8000-00000000000c",
      environment: "prod",
      valid_until: "2026-11-23T08:00:00.000Z",
      remedy: { kind: "renew", href: "/cockpit/tasks/00000000-0000-4000-8000-00000000000b" },
    },
    actionable: ACTIONABLE,
    resource: pointsAt("task", "task_id"),
  },
  "task_run.started": {
    name: "task_run.started",
    schema: TaskRunStarted,
    example: {
      task_run_id: "00000000-0000-4000-8000-000000000009",
      task_id: "00000000-0000-4000-8000-00000000000a",
      trigger: "cron",
      environment: "prod",
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("task_run", "task_run_id"),
  },
  "task_run.waiting": {
    name: "task_run.waiting",
    schema: TaskRunWaiting,
    example: {
      task_run_id: "00000000-0000-4000-8000-000000000009",
      task_id: "00000000-0000-4000-8000-00000000000a",
      trigger: "cron",
      waiting_reason: "question",
    },
    actionable: ACTIONABLE,
    resource: pointsAt("task_run", "task_run_id"),
  },
  "task_run.result_ready": {
    name: "task_run.result_ready",
    schema: TaskRunResultReady,
    example: {
      task_run_id: "00000000-0000-4000-8000-000000000009",
      task_id: "00000000-0000-4000-8000-00000000000a",
      trigger: "cron",
      turns_used: 6,
    },
    actionable: ACTIONABLE,
    resource: pointsAt("task_run", "task_run_id"),
  },
  "task_run.completed": {
    name: "task_run.completed",
    schema: TaskRunCompleted,
    example: {
      task_run_id: "00000000-0000-4000-8000-000000000009",
      task_id: "00000000-0000-4000-8000-00000000000a",
      trigger: "manual",
      turns_used: 6,
      duration_ms: 184000,
    },
    actionable: NOT_ACTIONABLE,
    resource: pointsAt("task_run", "task_run_id"),
  },
  "task_run.failed": {
    name: "task_run.failed",
    schema: TaskRunFailed,
    example: {
      task_run_id: "00000000-0000-4000-8000-000000000009",
      task_id: "00000000-0000-4000-8000-00000000000a",
      trigger: "cron",
      failure_code: "turn_interrupted",
    },
    actionable: ACTIONABLE,
    resource: pointsAt("task_run", "task_run_id"),
  },
} as const satisfies Record<string, EventCatalogEntry>;

type EventType = keyof typeof EVENT_CATALOG;
export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

export function isKnownEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_CATALOG, type);
}

export function validateEventPayload(
  type: string,
  payload: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!isKnownEventType(type)) {
    return { ok: false, error: `unknown event type: ${type}` };
  }
  const entry = EVENT_CATALOG[type];
  const result = entry.schema.safeParse(payload);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, value: result.data };
}

interface EventClassification {
  actionable: boolean;
  resource_type: string | null;
  resource_id: string | null;
}

export function classifyEvent(type: string, payload: unknown): EventClassification {
  if (!isKnownEventType(type)) {
    return { actionable: false, resource_type: null, resource_id: null };
  }
  const entry: EventCatalogEntry = EVENT_CATALOG[type];
  const pointer = entry.resource(payload);
  return {
    actionable: entry.actionable(payload),
    resource_type: pointer?.type ?? null,
    resource_id: pointer?.id ?? null,
  };
}

export function matchEventPattern(pattern: string, type: string): boolean {
  const parts = pattern
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === "*" || p === type) return true;
    if (p.endsWith(".*")) {
      const prefix = p.slice(0, -1);
      if (type.startsWith(prefix)) return true;
    }
  }
  return false;
}
