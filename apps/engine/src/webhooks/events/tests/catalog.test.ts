import { describe, expect, test } from "bun:test";
import type {
  ConnectorAuthFailedPayload,
  ConnectorHealthChangedPayload,
} from "../../../pubsub/types.ts";
import {
  classifyEvent,
  EVENT_CATALOG,
  EVENT_TYPES,
  isKnownEventType,
  matchEventPattern,
  validateEventPayload,
} from "../catalog.ts";

describe("events catalog", () => {
  test("catalog covers every P11 event type", () => {
    expect(EVENT_TYPES).toEqual([
      "execution.succeeded",
      "execution.failed",
      "execution.refused",
      "workflow.updated",
      "connector.oauth.refreshed",
      "connector.oauth.callback_succeeded",
      "connector.oauth.callback_failed",
      "connector.oauth.signin_finished",
      "connector.auth_failed",
      "connector.health_changed",
      "patch.proposed",
      "patch.applied",
      "apikey.rotated",
      "conversation.committed",
      "schedule.auto_paused",
      "workflow.approval_expiring",
      "task.grant_expiring",
      "task_run.started",
      "task_run.waiting",
      "task_run.result_ready",
      "task_run.completed",
      "task_run.failed",
    ]);
  });

  test("validateEventPayload accepts a connector.oauth.callback_succeeded payload", () => {
    const res = validateEventPayload("connector.oauth.callback_succeeded", {
      connector_id: "33333333-3333-4333-8333-333333333333",
      connector_slug: "google-gmail",
      has_refresh_token: true,
      source: "oauth_callback",
    });
    expect(res.ok).toBe(true);
  });

  test("validateEventPayload accepts a connector.oauth.callback_failed payload", () => {
    const res = validateEventPayload("connector.oauth.callback_failed", {
      connector_id: "33333333-3333-4333-8333-333333333333",
      connector_slug: "google-gmail",
      reason: "provider_error",
    });
    expect(res.ok).toBe(true);
  });

  test("validateEventPayload rejects a free-text connector.oauth.callback_failed reason", () => {
    const res = validateEventPayload("connector.oauth.callback_failed", {
      connector_id: "33333333-3333-4333-8333-333333333333",
      connector_slug: "google-gmail",
      reason: "the provider said access_denied for state=abc123",
    });
    expect(res.ok).toBe(false);
  });

  test("validateEventPayload accepts both endings of connector.oauth.signin_finished", () => {
    const connector_id = "33333333-3333-4333-8333-333333333333";
    expect(
      validateEventPayload("connector.oauth.signin_finished", {
        connector_id,
        connector_slug: "google-gmail",
        outcome: "succeeded",
        reason: null,
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("connector.oauth.signin_finished", {
        connector_id,
        connector_slug: null,
        outcome: "failed",
        reason: "token_exchange_failed",
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("connector.oauth.signin_finished", {
        connector_id,
        connector_slug: "google-gmail",
        outcome: "half_done",
        reason: null,
      }).ok,
    ).toBe(false);
  });

  test("isKnownEventType", () => {
    expect(isKnownEventType("execution.succeeded")).toBe(true);
    expect(isKnownEventType("execution.frobbed")).toBe(false);
  });

  test("validateEventPayload accepts a well-formed payload", () => {
    const res = validateEventPayload("execution.succeeded", {
      execution_id: "11111111-1111-4111-8111-111111111111",
      workflow_id: "22222222-2222-4222-8222-222222222222",
      duration_ms: 1000,
    });
    expect(res.ok).toBe(true);
  });

  test("validateEventPayload rejects a bad payload", () => {
    const res = validateEventPayload("execution.succeeded", {
      execution_id: "not-a-uuid",
      workflow_id: "22222222-2222-4222-8222-222222222222",
      duration_ms: -5,
    });
    expect(res.ok).toBe(false);
  });

  test("matchEventPattern handles *, prefix.*, and exact", () => {
    expect(matchEventPattern("*", "execution.succeeded")).toBe(true);
    expect(matchEventPattern("execution.*", "execution.succeeded")).toBe(true);
    expect(matchEventPattern("execution.*", "workflow.updated")).toBe(false);
    expect(matchEventPattern("execution.succeeded", "execution.succeeded")).toBe(true);
    expect(matchEventPattern("execution.succeeded", "execution.failed")).toBe(false);
    expect(matchEventPattern("execution.*,workflow.updated", "workflow.updated")).toBe(true);
  });
});

const EXAMPLES_WITHOUT_POINTER: ReadonlySet<string> = new Set();

describe("event classification", () => {
  test("every catalog entry validates its own example and answers what it points at", () => {
    const types = Object.keys(EVENT_CATALOG);
    expect(types.length).toBe(EVENT_TYPES.length);
    for (const type of types) {
      const entry = EVENT_CATALOG[type as keyof typeof EVENT_CATALOG];
      expect(entry.name as string).toBe(type);

      const parsed = entry.schema.safeParse(entry.example);
      expect(`${type}: ${parsed.success ? "ok" : JSON.stringify(parsed.error?.issues)}`).toBe(
        `${type}: ok`,
      );

      const classification = classifyEvent(type, entry.example);
      expect(typeof classification.actionable).toBe("boolean");
      if (EXAMPLES_WITHOUT_POINTER.has(type)) {
        expect(classification.resource_type).toBeNull();
        expect(classification.resource_id).toBeNull();
      } else {
        expect(`${type}: ${classification.resource_type}`).not.toBe(`${type}: null`);
        expect(`${type}: ${classification.resource_id}`).not.toBe(`${type}: null`);
      }
    }
  });

  test("pointers use the audit/RBAC resource ontology, not cockpit routes", () => {
    const ontology = new Set([
      "api_key",
      "connector",
      "conversation",
      "execution",
      "patch_candidate",
      "task",
      "task_run",
      "workflow",
    ]);
    for (const type of Object.keys(EVENT_CATALOG)) {
      const entry = EVENT_CATALOG[type as keyof typeof EVENT_CATALOG];
      const pointer = entry.resource(entry.example);
      if (pointer === null) continue;
      expect(`${type}: ${pointer.type}`).toBe(
        `${type}: ${ontology.has(pointer.type) ? pointer.type : "NOT_IN_ONTOLOGY"}`,
      );
      expect(pointer.type).not.toContain("/");
    }
  });

  test("connector.auth_failed validates the payload its emitter writes", () => {
    const emitted: ConnectorAuthFailedPayload = {
      severity: "error",
      workflow_id: null,
      connector_id: "33333333-3333-4333-8333-333333333333",
      connector_slug: "google-gmail",
      reason: "credential_rejected",
      reauth_url:
        "https://engine.example.com/v1/connectors/33333333-3333-4333-8333-333333333333/oauth/start",
    };
    expect(validateEventPayload("connector.auth_failed", emitted).ok).toBe(true);
    expect(classifyEvent("connector.auth_failed", emitted)).toEqual({
      actionable: true,
      resource_type: "connector",
      resource_id: "33333333-3333-4333-8333-333333333333",
    });
  });

  test("execution.refused validates the payload finalize writes and is not actionable", () => {
    const emitted = {
      execution_id: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      workflow_id: "22222222-2222-4222-8222-222222222222",
      request_source: "api",
      failure: {
        step_id: "send",
        error_code: "prepared_credential_unavailable",
        error_message: 'Connector "gmail" in dev must be reconnected before this workflow can run.',
        connector: { connector_id: "33333333-3333-4333-8333-333333333333", reason: "needs_reauth" },
      },
    };
    expect(validateEventPayload("execution.refused", emitted).ok).toBe(true);
    expect(classifyEvent("execution.refused", emitted)).toEqual({
      actionable: false,
      resource_type: "execution",
      resource_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("connector.health_changed validates the payload its emitter writes", () => {
    const emitted: ConnectorHealthChangedPayload = {
      severity: "error",
      workflow_id: "22222222-2222-4222-8222-222222222222",
      connector_id: "33333333-3333-4333-8333-333333333333",
      connector_slug: "google-gmail",
      from_state: "ok",
      to_state: "needs_update",
      error_code: "endpoint_removed",
      reason: "endpoint returned 410 Gone",
      sunset_at: null,
      successor_uri: null,
    };
    expect(validateEventPayload("connector.health_changed", emitted).ok).toBe(true);
  });

  test("connector.health_changed is actionable only for endpoint_removed", () => {
    const base: ConnectorHealthChangedPayload = {
      severity: "error",
      workflow_id: null,
      connector_id: "33333333-3333-4333-8333-333333333333",
      connector_slug: "google-gmail",
      from_state: "ok",
      to_state: "needs_update",
      error_code: "endpoint_removed",
      reason: "endpoint returned 410 Gone",
      sunset_at: null,
      successor_uri: null,
    };
    expect(classifyEvent("connector.health_changed", base).actionable).toBe(true);

    const deprecated: ConnectorHealthChangedPayload = {
      ...base,
      severity: "warn",
      error_code: "endpoint_deprecated",
      reason: "endpoint announced a sunset date",
      sunset_at: "2026-12-01T00:00:00.000Z",
    };
    expect(classifyEvent("connector.health_changed", deprecated).actionable).toBe(false);
    expect(classifyEvent("connector.health_changed", deprecated).resource_type).toBe("connector");

    const degraded: ConnectorHealthChangedPayload = {
      ...base,
      severity: "warn",
      to_state: "degraded",
      error_code: null,
      reason: "repeated 5xx",
    };
    expect(classifyEvent("connector.health_changed", degraded).actionable).toBe(false);
  });

  test("classifyEvent returns all-null for an unknown type and does not throw", () => {
    expect(classifyEvent("something.unknown", {})).toEqual({
      actionable: false,
      resource_type: null,
      resource_id: null,
    });
  });

  test("classifyEvent survives a malformed payload on a known type", () => {
    for (const payload of [null, undefined, 42, "text", [], { execution_id: 7 }]) {
      expect(classifyEvent("execution.failed", payload)).toEqual({
        actionable: true,
        resource_type: null,
        resource_id: null,
      });
    }
  });
});
