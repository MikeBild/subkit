// P11: central events catalog.
//
// Every event type that can be emitted onto the outbox + webhook fanout
// has a stable name, a zod payload schema, and a worked example. The
// outbox writer can reuse the schema to reject malformed payloads
// before insert; the fanout handler uses the name list to understand
// which events to consider for subscription matching.
//
// Each entry also states what the event POINTS AT (`resource`) and
// whether a person has to act on it (`actionable`) — see `classifyEvent`.

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

// A repair that actually rewrote a step and rotated the workflow version.
// Distinct from `patch.proposed` on purpose: a proposal asks for a decision,
// this one reports a workflow that already changed. Without it the only signal
// an operator ever got was "proposed" — including for patches applied in the
// same breath — and the pending-review list, which by definition never shows
// an applied one.
const PatchApplied = z.object({
  patch_candidate_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  workflow_version_id: z.string().uuid(),
  /** Which fields of the step the repair rewrote. */
  changed_paths: z.array(z.string()),
  /** True when policy applied it without waiting for a human decision. */
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

// ---------------------------------------------------------------------------
// Actionability + resource pointer
// ---------------------------------------------------------------------------
//
// The inbox (`cli_notification_inbox`) has three consumers — the cockpit SPA,
// the `sk` CLI, and any `notification:read` API client. Each row has to answer
// "does a person have to do something about this, and what does it concern".
// The rule lives here, next to the payload schemas, so those three consumers
// read one answer instead of three copies that drift.
//
// The pointer is `{ type, id }` in the `audit_log.resource_type` /
// `rbac/permissions.json` vocabulary — deliberately NOT a cockpit URL:
// `/runs/<id>` means nothing to the CLI, and a route rename would turn into a
// data migration over persisted inbox rows.

/** Whether a person has to act on this event. Payload-dependent for events
 *  whose severity lives in the payload rather than in the type name. */
type ActionablePredicate = (payload: unknown) => boolean;

/** What the event concerns, in the audit-log resource ontology. */
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

/**
 * Build a resource extractor that reads one id key off the payload. Total by
 * construction: a malformed / absent / non-string id yields `null` rather
 * than throwing, because `writeEvent` is not gated on this catalog.
 */
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
    // A removed endpoint blocks workflows until someone rewrites them.
    // `endpoint_deprecated` / `degraded` still work today, so they inform
    // rather than demand — same split the emitter makes for `severity`.
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

export type EventType = keyof typeof EVENT_CATALOG;
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

export interface EventClassification {
  actionable: boolean;
  resource_type: string | null;
  resource_id: string | null;
}

/**
 * Classify an event for the task inbox: does a person have to act, and what
 * does the row concern.
 *
 * Total on `type` AND on `payload`. `writeEvent` is not gated on this catalog,
 * so unknown types genuinely reach the fanout — an unknown type is not
 * actionable and points at nothing, rather than an exception that would take
 * the fanout down with it.
 */
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

/**
 * Simple glob match used by the fanout pass.
 *   "*"                → matches anything
 *   "execution.*"      → matches execution.succeeded / execution.failed
 *   "execution.succeeded" → exact match
 * Multiple comma-separated patterns are supported: "a.*,b.c".
 */
export function matchEventPattern(pattern: string, type: string): boolean {
  const parts = pattern
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === "*" || p === type) return true;
    if (p.endsWith(".*")) {
      const prefix = p.slice(0, -1); // "execution."
      if (type.startsWith(prefix)) return true;
    }
  }
  return false;
}
