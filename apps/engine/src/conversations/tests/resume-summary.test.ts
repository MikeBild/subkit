// Resume summary — one-sentence recap + next-best-action across states.

import { describe, expect, test } from "bun:test";
import { buildResumeSummary, shouldShowResumeSummary } from "../resume.ts";
import type { ConversationRecord, DraftDocument } from "../types.ts";

const TEST_NOW_MS = 1_700_000_000_000;

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
      },
    });
    expect(s.stage).toBe("awaiting_approval");
    expect(s.pending_approval?.tool_name).toBe("ask_user_confirm");
    expect(s.one_sentence.toLowerCase()).toContain("approval");
  });
});
