// Resume summary — one-sentence recap + next-best-action across states.

import { describe, expect, test } from "bun:test";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  createEmptyDraftDocument,
  withWorkflowDraft,
  withWorkflowPersisted,
} from "../authoring-state.ts";
import { buildResumeSummary, shouldShowResumeSummary } from "../resume.ts";
import type { ConversationRecord, DraftDocument } from "../types.ts";

const TEST_NOW_MS = getTestNow();

function conv(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: "c1",
    tenant_id: "t1",
    target_workflow_id: null,
    target_connector_id: null,
    status: "active",
    owner_id: null,
    model: null,
    title: null,
    created_at: new Date(TEST_NOW_MS).toISOString(),
    updated_at: new Date(TEST_NOW_MS).toISOString(),
    ...overrides,
  } as ConversationRecord;
}

describe("buildResumeSummary", () => {
  test("shouldShowResumeSummary is false for committed conversations", () => {
    expect(
      shouldShowResumeSummary({
        conversation: conv({ status: "committed" }),
        draft: {
          workflow: {
            name: "w",
            steps: [{ id: "s1", kind: "request" }],
          },
        } as DraftDocument,
      }),
    ).toBe(false);
  });

  test("shouldShowResumeSummary is false for empty draft", () => {
    expect(
      shouldShowResumeSummary({
        conversation: conv(),
        draft: { workflow: { name: "new-workflow", steps: [] } } as DraftDocument,
      }),
    ).toBe(false);
  });

  test("exposes a pending text question before a draft exists", () => {
    const pendingElicitation = {
      id: "question-1",
      tool_name: "ask_user_text",
      summary: "Which colour?",
      expires_at: "2099-01-01T00:00:00Z",
    };
    for (const draft of [
      null,
      { workflow: { name: "new-workflow", steps: [] } } as DraftDocument,
    ]) {
      const params = {
        conversation: conv({ status: "awaiting_input" }),
        draft,
        pendingElicitation,
      };
      expect(shouldShowResumeSummary(params)).toBe(true);
      expect(buildResumeSummary(params).pending_approval).toEqual(pendingElicitation);
      expect(buildResumeSummary(params).stage).toBe("awaiting_approval");
    }
  });

  test("does not resurrect a terminal conversation for an old pending question", () => {
    for (const status of ["committed", "abandoned"] as const) {
      expect(
        shouldShowResumeSummary({
          conversation: conv({ status }),
          draft: null,
          pendingElicitation: {
            id: "old-question",
            tool_name: "ask_user_text",
            expires_at: "2099-01-01T00:00:00Z",
          },
        }),
      ).toBe(false);
    }
  });

  test("shouldShowResumeSummary is true once a connector draft exists", () => {
    expect(
      shouldShowResumeSummary({
        conversation: conv(),
        draft: {
          workflow: { name: "new-workflow", steps: [] },
          connector: { name: "X", driver: "http" },
        } as DraftDocument,
      }),
    ).toBe(true);
  });

  test("connector drafting (no probe) → next action probe", () => {
    const s = buildResumeSummary({
      conversation: conv(),
      draft: {
        workflow: { name: "new-workflow", steps: [] },
        connector: { name: "Acme", driver: "http", auth_type: "bearer", environment: "dev" },
      } as DraftDocument,
    });
    expect(s.active_target.kind).toBe("connector");
    expect(s.active_target.name).toBe("Acme");
    expect(s.stage).toBe("connector_drafting");
    expect(s.next_action).toContain("Probe");
    expect(s.one_sentence).toContain("Acme");
  });

  test("connector probed ok → next action save", () => {
    const s = buildResumeSummary({
      conversation: conv(),
      draft: {
        workflow: { name: "new-workflow", steps: [] },
        connector: {
          name: "Acme",
          driver: "http",
          environment: "dev",
          latest_probe: { ok: true, method: "GET", path: "/", environment: "dev", summary: "ok" },
        },
      } as DraftDocument,
    });
    expect(s.stage).toBe("connector_ready_to_save");
    expect(s.next_action).toContain("Save");
  });

  test("workflow drafting (no preview) → next action preview", () => {
    const s = buildResumeSummary({
      conversation: conv(),
      draft: {
        workflow: {
          name: "my-flow",
          steps: [{ id: "s1", kind: "request" }],
        },
      } as DraftDocument,
    });
    expect(s.active_target.kind).toBe("workflow");
    expect(s.active_target.name).toBe("my-flow");
    expect(s.stage).toBe("workflow_drafting");
    expect(s.next_action).toContain("Preview");
  });

  test("workflow previewed ok → next action commit", () => {
    const s = buildResumeSummary({
      conversation: conv(),
      draft: {
        workflow: {
          name: "my-flow",
          steps: [{ id: "s1", kind: "request" }],
        },
        latest_preview: { ok: true, step_id: "s1", summary: "ok" },
      } as DraftDocument,
    });
    expect(s.stage).toBe("workflow_ready_to_commit");
    expect(s.next_action).toContain("Commit");
  });

  test("pending approval is surfaced in one_sentence", () => {
    const s = buildResumeSummary({
      conversation: conv(),
      draft: {
        workflow: {
          name: "my-flow",
          steps: [{ id: "s1", kind: "request" }],
        },
      } as DraftDocument,
      pendingElicitation: {
        id: "e1",
        tool_name: "ask_user_confirm",
        summary: "commit workflow?",
        expires_at: "2026-08-18T12:00:00.000Z",
      },
    });
    expect(s.stage).toBe("awaiting_approval");
    expect(s.pending_approval?.tool_name).toBe("ask_user_confirm");
    // The deadline reaches the client verbatim — a resume banner that cannot
    // say how long is left is the gap this field closes.
    expect(s.pending_approval?.expires_at).toBe("2026-08-18T12:00:00.000Z");
    expect(s.one_sentence.toLowerCase()).toContain("approval");
  });
});

describe("saved workflow resume", () => {
  function saved() {
    const draft = withWorkflowDraft(createEmptyDraftDocument("workflow_authoring"), {
      name: "Weekly report",
      slug: "weekly-report",
      steps: [{ id: "result", kind: "transform", config: { expression: "1" } }],
    });
    return withWorkflowPersisted(draft, {
      kind: "workflow",
      id: "workflow-1",
      name: "Weekly report",
      slug: "weekly-report",
      version_id: "version-6",
      version: 6,
      environment: null,
      saved_at: new Date(TEST_NOW_MS).toISOString(),
      persistence_kind: "draft",
      draft_version_id: "version-6",
      current_version_id: "version-5",
    });
  }
  test("saving finishes preparation without claiming activation or asking to save again", () => {
    const result = buildResumeSummary({
      conversation: conv({ target_workflow_id: "workflow-1" }),
      draft: saved(),
    });
    expect(result.stage).toBe("workflow_saved");
    expect(result.unsaved).toBe(false);
    expect(result.next_action).toContain("Review activation");
    expect(result.next_action).not.toContain("Commit the workflow");
  });
  test("a stale saved checkpoint does not hide unsaved changes", () => {
    const draft = saved();
    if (!draft.state) throw new Error("missing authoring state");
    draft.state.workflow_mutation_seq += 1;
    const result = buildResumeSummary({ conversation: conv(), draft });
    expect(result.stage).not.toBe("workflow_saved");
    expect(result.unsaved).toBe(true);
  });
  test("a real pending decision takes priority over the saved checkpoint", () => {
    const result = buildResumeSummary({
      conversation: conv(),
      draft: saved(),
      pendingElicitation: {
        id: "pending",
        tool_name: "ask_user_confirm",
        expires_at: "2099-01-01T00:00:00Z",
      },
    });
    expect(result.stage).toBe("awaiting_approval");
    expect(result.unsaved).toBe(false);
  });
});
