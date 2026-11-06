import { z } from "@hono/zod-openapi";
import {
  ConnectorAuthFailedPayloadSchema,
  ConnectorHealthChangedPayloadSchema,
  ConnectorOauthCallbackFailedPayloadSchema,
  ConnectorOauthCallbackPayloadSchema,
} from "../../pubsub/index.ts";

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
