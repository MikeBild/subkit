// Targeted tests for `computeBlockedBy` — specifically the OAuth2
// lifecycle ordering. The Gmail dead-end (conversation 37a6d350,
// 2026-05-12) reached `blocked_by: ["authenticate_oauth",
// "probe_connector_draft"]` simultaneously, which trapped the model:
// `probe_connector_draft` cannot succeed before tokens exist, but the
// suggestion fired in parallel with `authenticate_oauth`. The
// documented lifecycle (docs/concepts/connectors.md) is save → authenticate
// → probe — these tests pin that ordering.

import { describe, expect, it } from "bun:test";

import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import type { AuthoringSummary, ConnectorDraftDocument, WorkflowDraftDocument } from "../types.ts";
import { createEmptyState } from "./normalize.ts";
import { computeBlockedBy } from "./summary.ts";

function activeConnector(): AuthoringSummary["active_target"] {
  return {
    kind: "connector",
    name: "Gmail",
    slug: "google-gmail",
    id: null,
    environment: "dev",
    lifecycle_state: "draft_only",
  };
}

function emptyWorkflow(): WorkflowDraftDocument {
  return { name: "", steps: [] };
}

function oauth2DraftValidated(): ConnectorDraftDocument {
  return {
    name: "Gmail",
    slug: "google-gmail",
    driver: "http",
    environment: "dev",
    auth_type: "oauth2",
    base_url: "https://gmail.googleapis.com",
    validation: { ok: true, missing_fields: [], errors: [] },
    config: { oauth: { client_id: "x", client_secret: "y" } },
  };
}

function freshen<
  K extends "connector_inspected" | "connector_validated" | "connector_authenticated",
>(state: ReturnType<typeof createEmptyState>, ...keys: K[]) {
  for (const key of keys) {
    state.checkpoints[key] = {
      key,
      mutation_seq: state.connector_mutation_seq,
      verified_at: new Date(FROZEN_NOW).toISOString(),
      verified_by_tool: "test",
      ok: true,
      summary: null,
    };
  }
  return state;
}

describe("computeBlockedBy — OAuth2 lifecycle ordering", () => {
  it("for OAuth2 drafts awaiting authentication, suggests authenticate_oauth and suppresses probe_connector_draft", () => {
    const state = freshen(
      createEmptyState("connector"),
      "connector_inspected",
      "connector_validated",
    );
    const blocked = computeBlockedBy(
      state,
      oauth2DraftValidated(),
      emptyWorkflow(),
      null,
      activeConnector(),
    );
    expect(blocked).toContain("authenticate_oauth");
    expect(blocked).not.toContain("probe_connector_draft");
  });

  it("after OAuth2 authentication, surfaces probe_connector_draft as the next blocker", () => {
    const state = freshen(
      createEmptyState("connector"),
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
    );
    const blocked = computeBlockedBy(
      state,
      oauth2DraftValidated(),
      emptyWorkflow(),
      null,
      activeConnector(),
    );
    expect(blocked).not.toContain("authenticate_oauth");
    expect(blocked).toContain("probe_connector_draft");
  });

  it("non-OAuth2 drafts surface probe_connector_draft alongside the credential gate (existing behaviour)", () => {
    const state = freshen(
      createEmptyState("connector"),
      "connector_inspected",
      "connector_validated",
    );
    const draft: ConnectorDraftDocument = {
      name: "GitHub",
      slug: "github-api",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.github.com",
      validation: { ok: true, missing_fields: [], errors: [] },
    };
    const blocked = computeBlockedBy(state, draft, emptyWorkflow(), null, activeConnector());
    expect(blocked).toContain("ask_user_form");
    expect(blocked).toContain("probe_connector_draft");
  });
});
