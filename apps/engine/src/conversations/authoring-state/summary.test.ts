import { describe, expect, it } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import type { AuthoringSummary, ConnectorDraftDocument, WorkflowDraftDocument } from "../types.ts";
import { createEmptyState } from "./normalize.ts";
import { computeBlockedBy, computeNextAction, computeReadiness } from "./summary.ts";

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

function workflowDraft(
  execution_privacy?: WorkflowDraftDocument["execution_privacy"],
): WorkflowDraftDocument {
  return {
    name: "github-briefing",
    ...(execution_privacy ? { execution_privacy } : {}),
    steps: [{ id: "read", kind: "transform", expression: "return {};", language: "javascript" }],
  };
}

function freshenWorkflow(
  state: ReturnType<typeof createEmptyState>,
  ...keys: Array<"workflow_inspected" | "workflow_validated">
) {
  for (const key of keys) {
    state.checkpoints[key] = {
      key,
      mutation_seq: state.workflow_mutation_seq,
      verified_at: new Date(FROZEN_NOW).toISOString(),
      verified_by_tool: "test",
      ok: true,
      summary: null,
    };
  }
  return state;
}

function activeWorkflow(): AuthoringSummary["active_target"] {
  return {
    kind: "workflow",
    name: "github-briefing",
    slug: "github-briefing",
    id: null,
    environment: "prod",
    lifecycle_state: "draft_only",
  };
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

describe("computeBlockedBy — sensitive workflow persistence", () => {
  it("allows an inspected and validated sensitive draft to save without a preview", () => {
    const state = freshenWorkflow(
      createEmptyState("workflow"),
      "workflow_inspected",
      "workflow_validated",
    );
    const draft = workflowDraft("sensitive");
    const active = activeWorkflow();
    const blocked = computeBlockedBy(state, null, draft, null, active);

    expect(blocked).not.toContain("dry_run_workflow");
    expect(blocked).toEqual([]);
    expect(computeReadiness(active, blocked)).toBe("ready_to_save");
    expect(computeNextAction(state, active, blocked, draft)).toContain(
      "runtime verification remains not performed",
    );
  });

  it("keeps inspection and validation freshness gates for sensitive drafts", () => {
    const state = freshenWorkflow(createEmptyState("workflow"), "workflow_inspected");
    const blocked = computeBlockedBy(
      state,
      null,
      workflowDraft("sensitive"),
      null,
      activeWorkflow(),
    );

    expect(blocked).toContain("validate_draft");
    expect(blocked).not.toContain("dry_run_workflow");
  });

  it("continues to require preview for ordinary workflow drafts", () => {
    const state = freshenWorkflow(
      createEmptyState("workflow"),
      "workflow_inspected",
      "workflow_validated",
    );
    const blocked = computeBlockedBy(state, null, workflowDraft(), null, activeWorkflow());

    expect(blocked).toContain("dry_run_workflow");
  });
});
