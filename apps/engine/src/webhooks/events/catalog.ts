// P11: central events catalog.
//
// Every event type that can be emitted onto the outbox + webhook fanout
// has a stable name, a zod payload schema, and a worked example. The
// outbox writer can reuse the schema to reject malformed payloads
// before insert; the fanout handler uses the name list to understand
// which events to consider for subscription matching.

import { z } from "@hono/zod-openapi";
import {
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

const ApiKeyRotated = z.object({
  api_key_id: z.string().uuid(),
  actor_id: z.string().uuid().nullable(),
});

const ConversationCommitted = z.object({
  conversation_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
});

export const EVENT_CATALOG = {
  "execution.succeeded": {
    name: "execution.succeeded",
    schema: ExecutionSucceeded,
    example: {
      execution_id: "00000000-0000-0000-0000-000000000001",
      workflow_id: "00000000-0000-0000-0000-000000000002",
      duration_ms: 1234,
    },
  },
  "execution.failed": {
    name: "execution.failed",
    schema: ExecutionFailed,
    example: {
      execution_id: "00000000-0000-0000-0000-000000000001",
      workflow_id: "00000000-0000-0000-0000-000000000002",
      error: "step invoice.fetch failed: timeout",
    },
  },
  "workflow.updated": {
    name: "workflow.updated",
    schema: WorkflowUpdated,
    example: {
      workflow_id: "00000000-0000-0000-0000-000000000002",
      version: 7,
      updated_by: null,
    },
  },
  "connector.oauth.refreshed": {
    name: "connector.oauth.refreshed",
    schema: ConnectorOAuthRefreshed,
    example: {
      connector_id: "00000000-0000-0000-0000-000000000003",
      credential_id: "00000000-0000-0000-0000-000000000004",
      environment: "prod",
      expires_at: "2026-05-01T00:00:00.000Z",
    },
  },
  "connector.oauth.callback_succeeded": {
    name: "connector.oauth.callback_succeeded",
    schema: ConnectorOauthCallbackPayloadSchema,
    example: {
      connector_id: "00000000-0000-0000-0000-000000000003",
      connector_slug: "google-gmail",
      has_refresh_token: true,
      source: "oauth_callback",
    },
  },
  "connector.oauth.callback_failed": {
    name: "connector.oauth.callback_failed",
    schema: ConnectorOauthCallbackFailedPayloadSchema,
    example: {
      connector_id: "00000000-0000-0000-0000-000000000003",
      connector_slug: "google-gmail",
      reason: "provider_error",
    },
  },
  "patch.proposed": {
    name: "patch.proposed",
    schema: PatchProposed,
    example: {
      patch_candidate_id: "00000000-0000-0000-0000-000000000005",
      workflow_id: "00000000-0000-0000-0000-000000000002",
      classification: "safe",
    },
  },
  "apikey.rotated": {
    name: "apikey.rotated",
    schema: ApiKeyRotated,
    example: {
      api_key_id: "00000000-0000-0000-0000-000000000006",
      actor_id: null,
    },
  },
  "conversation.committed": {
    name: "conversation.committed",
    schema: ConversationCommitted,
    example: {
      conversation_id: "00000000-0000-0000-0000-000000000008",
      workflow_id: "00000000-0000-0000-0000-000000000002",
    },
  },
} as const;

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
