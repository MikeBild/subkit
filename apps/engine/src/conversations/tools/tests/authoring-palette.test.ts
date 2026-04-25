// Locks the chat-first-repair contract for the conversation tool palette.
//
// Background: a user runs an existing (persisted) workflow, it fails on
// a stale connector reference, the agent diagnoses it, the user says
// "ja repariere und commit das", the agent edits the draft and calls
// validate_draft. At that point the persisted workflow is in a valid
// state to re-commit (commit_draft updates in place). If the palette
// hides commit_draft, the model has no in-chat path to persist the
// repair and falls back to abstaining via cannot_help — typically with
// a reason that points the user to the `sk` CLI. That breaks the
// chat-first contract.

import { describe, expect, test } from "bun:test";
import type { AuthoringSummary } from "../../types.ts";
import { workflowPersistedAllowsRecommit } from "../authoring-palette.ts";

function summary(over: Partial<AuthoringSummary>): AuthoringSummary {
  return {
    readiness: "drafting",
    next_action: null,
    next_required_action: null,
    missing_fields: [],
    last_action: null,
    progress_label: null,
    mode: "workflow",
    stage: "diagnosing",
    lifecycle_state: "persisted",
    active_target: {
      kind: "workflow",
      name: "GitHub Private Repos MikeBild",
      slug: "github-private-mikebild",
      id: "wf-abc",
      environment: "dev",
      lifecycle_state: "persisted",
    },
    blocked_by: [],
    checkpoints: [],
    persisted_resources: [
      {
        kind: "workflow",
        id: "wf-abc",
        slug: "github-private-mikebild",
        name: "GitHub Private Repos MikeBild",
        version_id: "wfv-1",
        version: 1,
        environment: "dev",
        saved_at: "2026-04-25T05:00:00Z",
      },
    ],
    latest_execution: null,
    latest_diagnosis: null,
    ...over,
  };
}

const FRESH_VALIDATED: AuthoringSummary["checkpoints"][number] = {
  key: "workflow_validated",
  status: "fresh",
  verified_at: "2026-04-25T05:00:00Z",
  verified_by_tool: "validate_draft",
  ok: true,
  summary: "ok",
};

import type { DraftDocument } from "../../types.ts";
import { filterByAuthoringPalette } from "../authoring-palette.ts";

describe("filterByAuthoringPalette — cleanup tools always reachable", () => {
  // Locks the chat-first delete contract. Without this, the palette
  // filter hid every delete_*/revoke_* tool from the focused authoring
  // states (anything except idle), so a user typing "lösche dummy-http"
  // mid-conversation got `cannot_help: "Löschen nicht verfügbar"` even
  // though the tool exists and is protected by the dangerous-tools
  // confirm gate. Session 9b9ea73b regression test.
  test("delete_connector / delete_workflow visible in workflow-persisted state", () => {
    const persisted: AuthoringSummary = {
      readiness: "saved",
      next_action: null,
      next_required_action: null,
      missing_fields: [],
      last_action: null,
      progress_label: null,
      mode: "workflow",
      stage: "workflow_persisted",
      lifecycle_state: "persisted",
      active_target: {
        kind: "workflow",
        name: "demo",
        slug: "demo",
        id: "wf-1",
        environment: "dev",
        lifecycle_state: "persisted",
      },
      blocked_by: [],
      checkpoints: [],
      persisted_resources: [],
      latest_execution: null,
      latest_diagnosis: null,
    };
    const draft: DraftDocument = {
      workflow: { name: "demo", steps: [{ id: "s1", kind: "request" }] } as never,
      summary: persisted,
    };
    const tools = [
      { name: "delete_connector" },
      { name: "delete_workflow" },
      { name: "revoke_api_key" },
      { name: "delete_knowledge_source" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, draft);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("delete_connector");
    expect(names).toContain("delete_workflow");
    expect(names).toContain("revoke_api_key");
    expect(names).toContain("delete_knowledge_source");
  });
});

describe("filterByAuthoringPalette — fresh-start state after delete_*", () => {
  // Locks the post-delete idle path (session 64db7189): when
  // active_target.kind drops to "none", the palette MUST still surface
  // the entry tools for both connector and workflow authoring,
  // otherwise the user cannot start anything new and the agent falls
  // back to cannot_help with "tool not available".
  test("idle / none active_target exposes both connector and workflow start tools", () => {
    const idleSummary: AuthoringSummary = {
      readiness: "drafting",
      next_action: null,
      next_required_action: null,
      missing_fields: [],
      last_action: null,
      progress_label: null,
      mode: "connector",
      stage: "idle",
      lifecycle_state: "none",
      active_target: {
        kind: "none",
        name: null,
        slug: null,
        id: null,
        environment: null,
        lifecycle_state: "none",
      },
      blocked_by: [],
      checkpoints: [],
      persisted_resources: [],
      latest_execution: null,
      latest_diagnosis: null,
    };
    const idleDraft: DraftDocument = {
      workflow: { name: "", steps: [] } as never,
      summary: idleSummary,
    };
    const tools = [
      { name: "start_connector_from_description" },
      { name: "start_connector_from_template" },
      { name: "start_workflow_from_goal" },
      { name: "list_connectors" },
      { name: "cannot_help" },
    ] as const;
    const filtered = filterByAuthoringPalette(tools, idleDraft);
    const names = filtered.map((t) => t.name);
    // Without this regression test the filter would hide the connector
    // entry tools when the idle state is reached via delete_connector,
    // exactly the bug the user hit in session 64db7189.
    expect(names).toContain("start_connector_from_description");
    expect(names).toContain("start_connector_from_template");
    expect(names).toContain("start_workflow_from_goal");
  });
});

describe("workflowPersistedAllowsRecommit — repair-and-save on a persisted workflow", () => {
  test("allows commit when the edited draft has been validated", () => {
    expect(
      workflowPersistedAllowsRecommit(
        summary({ stage: "workflow_validated", checkpoints: [FRESH_VALIDATED] }),
      ),
    ).toBe(true);
  });

  test("denies commit when validate_draft has not been re-run", () => {
    expect(
      workflowPersistedAllowsRecommit(
        summary({ stage: "diagnosing", checkpoints: [], blocked_by: ["validate_draft"] }),
      ),
    ).toBe(false);
  });

  test("denies commit when fields are still missing, even if validated", () => {
    expect(
      workflowPersistedAllowsRecommit(
        summary({
          stage: "workflow_validated",
          missing_fields: ["base_url"],
          blocked_by: ["missing:base_url"],
          checkpoints: [FRESH_VALIDATED],
        }),
      ),
    ).toBe(false);
  });

  test("denies commit when inspect_workflow_draft is still pending", () => {
    expect(
      workflowPersistedAllowsRecommit(
        summary({ blocked_by: ["inspect_workflow_draft"], checkpoints: [FRESH_VALIDATED] }),
      ),
    ).toBe(false);
  });

  test("denies commit on a connector active target (workflow-only path)", () => {
    expect(
      workflowPersistedAllowsRecommit(
        summary({
          mode: "connector",
          active_target: {
            kind: "connector",
            name: "github-graphql",
            slug: "github-graphql",
            id: "c-abc",
            environment: "dev",
            lifecycle_state: "persisted",
          },
          checkpoints: [FRESH_VALIDATED],
        }),
      ),
    ).toBe(false);
  });

  test("denies commit on a draft-only workflow (use the existing draft-only gate instead)", () => {
    expect(
      workflowPersistedAllowsRecommit(
        summary({
          lifecycle_state: "draft_only",
          active_target: {
            kind: "workflow",
            name: "fresh-draft",
            slug: "fresh-draft",
            id: null,
            environment: "dev",
            lifecycle_state: "draft_only",
          },
          checkpoints: [FRESH_VALIDATED],
        }),
      ),
    ).toBe(false);
  });
});
