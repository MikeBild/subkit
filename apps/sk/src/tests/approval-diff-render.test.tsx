// Coverage for the structured-diff confirmation renderer (gap #9).
//
// Drives `<ApprovalRouter>` with a `commit_intent` of kind
// `save_connector_draft`, stubs `engineClient.connectors.get` (in our
// EngineClient that's `getConnector`), and asserts:
//   - the diff frame contains the three markers (+ added,
//     - removed, +/- for changed)
//   - a fetch failure falls back to the legacy text dump with a
//     `(diff unavailable)` banner so the operator can still approve
//   - the `d` keypress toggles truncated → expanded view
//
// Uses `renderInk` from helpers/ink.tsx so frames are ANSI-stripped
// and assertions stay stable across terminal widths.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PendingElicitation } from "@cli-core/index.ts";
import type { EngineClient } from "../engine-client.ts";
import { _resetPersistedStateCache } from "../repl/approval/generic.tsx";
import { ApprovalRouter } from "../repl/approval/router.tsx";
import { renderInk } from "./helpers/ink.tsx";

interface StubClient {
  getConnector: (id: string) => Promise<Record<string, unknown>>;
  getWorkflow: (id: string) => Promise<Record<string, unknown>>;
}

function asEngineClient(stub: StubClient): EngineClient {
  // The router only invokes `getConnector` / `getWorkflow`; cast through
  // unknown so we don't have to construct the entire EngineClient.
  return stub as unknown as EngineClient;
}

function elicitation(payload: Record<string, unknown>): PendingElicitation {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    tool_name: "ask_user_confirm",
    summary: "Save the connector draft?",
    input: {
      kind: "generic",
      commit_intent: {
        kind: "save_connector_draft",
        description: "Persist the GitHub connector draft",
        payload,
      },
    },
  };
}

beforeEach(() => {
  _resetPersistedStateCache();
});

afterEach(() => {
  _resetPersistedStateCache();
});

describe("ApprovalRouter — structured diff for commit_intent", () => {
  test("renders +, -, and changed markers from a save_connector_draft intent", async () => {
    const current = {
      connector_id: "conn-1",
      name: "GitHub",
      // `description` is the field that will be REMOVED.
      description: "old description",
      config: { base_url: "https://api.github.com", timeout_ms: 5000 },
    };
    const proposed = {
      connector_id: "conn-1",
      name: "GitHub",
      // description is removed
      // timeout_ms changes 5000 -> 30000 (changed-removed + changed-added)
      // notes is added
      notes: "rotated 2026-04-26",
      config: { base_url: "https://api.github.com", timeout_ms: 30000 },
    };
    const stub: StubClient = {
      getConnector: async () => current,
      getWorkflow: async () => ({}),
    };
    const ui = renderInk(
      <ApprovalRouter
        approval={elicitation(proposed)}
        engineClient={asEngineClient(stub)}
        inputDisabled={true}
      />,
    );
    try {
      // Wait for the loading state to clear.
      await ui.waitFor((t) => !t.includes("loading diff..."), { label: "diff loaded" });
      const txt = ui.text();
      // Removed marker — `description: "old description"` line.
      expect(txt).toContain("- ");
      expect(txt).toContain("description");
      // Added marker — `notes: "rotated 2026-04-26"` line.
      expect(txt).toContain("+ ");
      expect(txt).toContain("notes");
      // Changed marker — both `- timeout_ms: 5000` and
      // `+ timeout_ms: 30000` should appear (diff renders changed
      // values as a removed + added pair).
      expect(txt).toContain("5000");
      expect(txt).toContain("30000");
    } finally {
      ui.unmount();
    }
  });

  test("fetch failure falls back to text-only summary with banner", async () => {
    const stub: StubClient = {
      getConnector: async () => {
        throw new Error("network down");
      },
      getWorkflow: async () => ({}),
    };
    const proposed = { connector_id: "conn-1", name: "x" };
    const ui = renderInk(
      <ApprovalRouter
        approval={elicitation(proposed)}
        engineClient={asEngineClient(stub)}
        inputDisabled={true}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("diff unavailable"), {
        label: "fallback banner shown",
      });
      const txt = ui.text();
      expect(txt).toContain("diff unavailable");
      expect(txt).toContain("network down");
      // The original approval header is still rendered.
      expect(txt).toContain("input needed: confirm: generic");
      expect(txt).toContain("Save the connector draft?");
      // /respond hint stays
      expect(txt).toContain("/respond");
    } finally {
      ui.unmount();
    }
  });

  test("`d` keypress expands truncated diff", async () => {
    // Build a fat proposed payload with > 30 lines of diff so the
    // truncation footer fires.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = { connector_id: "conn-1" };
    for (let i = 0; i < 40; i++) after[`field_${String(i).padStart(2, "0")}`] = `v_${i}`;
    const stub: StubClient = {
      getConnector: async () => before,
      getWorkflow: async () => ({}),
    };
    const ui = renderInk(
      <ApprovalRouter
        approval={elicitation(after)}
        engineClient={asEngineClient(stub)}
        // inputDisabled is omitted so the JsonDiff useInput listener
        // is active and `d` toggles expand.
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("more lines (toggle with d)"), {
        label: "truncation footer shown",
      });
      const collapsed = ui.text();
      expect(collapsed).toContain("more lines (toggle with d)");
      // Press `d` to expand. `useInput` in ink may swallow the keystroke
      // when the test's stdin write lands before the listener registers,
      // so we yield once and retry until the expanded footer is visible.
      // allow-wall-clock: ink's keypress parser needs ms to settle the
      // raw-mode listener; same pattern as form-prompt's keystroke tests.
      await new Promise((r) => setTimeout(r, 40));
      await ui.type("d");
      await ui.waitFor((t) => t.includes("press d to collapse"), {
        label: "expanded footer shown",
      });
      const expanded = ui.text();
      // Should show the late field (field_39) which was hidden in the
      // truncated view.
      expect(expanded).toContain("field_39");
      expect(expanded).not.toContain("more lines (toggle with d)");
      expect(expanded).toContain("press d to collapse");
    } finally {
      ui.unmount();
    }
  });
});
