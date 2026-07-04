// Events catalog unit tests — pure zod, no DB.

import { describe, expect, test } from "bun:test";
import {
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
      "workflow.updated",
      "connector.oauth.refreshed",
      "connector.oauth.callback_succeeded",
      "connector.oauth.callback_failed",
      "patch.proposed",
      "apikey.rotated",
      "conversation.committed",
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
    // `reason` is constrained to a sanitized-token allowlist — raw
    // provider error strings must never reach the wire. `connector_slug`
    // is carried for symmetry with the success event so a webhook consumer
    // can correlate success/failure pairs.
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
    // comma separated list
    expect(matchEventPattern("execution.*,workflow.updated", "workflow.updated")).toBe(true);
  });
});
