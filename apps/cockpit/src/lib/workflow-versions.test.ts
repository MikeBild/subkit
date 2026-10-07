import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  restoredFrom,
  type WorkflowVersion,
  workflowVersionSheetCopy,
  workflowVersionView,
} from "./workflow-versions";

function version(n: number, overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: `version-${n}`,
    workflow_id: "workflow-1",
    version: n,
    note: null,
    created_at: "2026-06-01T00:00:00.000Z",
    invalid: false,
    ...overrides,
  };
}

const history = [version(4), version(3), version(2), version(1)];

describe("workflow version rows", () => {
  test("the newest version offers no restore; it already is the latest state", () => {
    const view = workflowVersionView(version(4), history, { current: "version-4", draft: null });
    expect(view).toMatchObject({ state: "current", newest: true, restorable: false });
  });

  test("an older version is restored into the next version number", () => {
    const view = workflowVersionView(version(2), history, { current: "version-4", draft: null });
    expect(view).toMatchObject({
      state: "superseded",
      newest: false,
      restorable: true,
      newestVersion: 4,
      nextVersion: 5,
    });
  });

  test("the active version behind a newer draft is not offered for restore", () => {
    const ids = { current: "version-3", draft: "version-4" };
    expect(workflowVersionView(version(3), history, ids)).toMatchObject({
      state: "current",
      restorable: false,
    });
    expect(workflowVersionView(version(4), history, ids)).toMatchObject({
      state: "draft",
      newest: true,
      restorable: false,
    });
  });

  test("a version that no longer fits the definition format cannot be restored", () => {
    const view = workflowVersionView(version(1, { invalid: true }), history, {
      current: "version-4",
      draft: null,
    });
    expect(view).toMatchObject({ state: "invalid", restorable: false });
  });

  test("a restore note names the version it came from", () => {
    expect(restoredFrom("restored from v3")).toBe(3);
    expect(restoredFrom("tightened the boundary")).toBeNull();
    expect(restoredFrom(null)).toBeNull();
  });
});

describe("workflow version sheet", () => {
  const ids = { current: "version-4", draft: null };
  const sheet = (n: number, canRestore = true, overrides: Partial<WorkflowVersion> = {}) =>
    workflowVersionSheetCopy(workflowVersionView(version(n, overrides), history, ids), {
      canRestore,
      archived: false,
    });

  test("an older version offers exactly the restore and says it creates a new version awaiting approval when the boundary grows", () => {
    const copy = sheet(2);
    expect(copy.restore).toBe(true);
    expect(translate("de", copy.hint, copy.values)).toBe(
      "Wiederherstellen legt v5 mit diesem Stand an. Wächst dabei die Grenze, wartet v5 auf Freigabe; v4 bleibt im Verlauf.",
    );
    expect(translate("en", copy.hint, copy.values)).toContain("waits for approval");
  });

  test("the newest version says so and offers nothing", () => {
    const copy = sheet(4);
    expect(copy.restore).toBe(false);
    expect(translate("de", copy.hint, copy.values)).toBe("Das ist die neueste Version.");
  });

  test("a reader who may not restore sees the reason instead of the action", () => {
    const copy = sheet(2, false);
    expect(copy.restore).toBe(false);
    expect(copy.hint).toBe("workflowVersions.restoreNotPermitted");
  });

  test("an outdated version explains why it cannot come back", () => {
    const copy = sheet(1, true, { invalid: true });
    expect(copy.restore).toBe(false);
    expect(copy.hint).toBe("workflowVersions.invalidHint");
  });
});

describe("restoring next to a disabled workflow or an open draft", () => {
  test("a disabled workflow offers no restore and says how to get it back", () => {
    const view = workflowVersionView(version(2), history, { current: "version-4", draft: null });
    const copy = workflowVersionSheetCopy(view, { canRestore: true, archived: true });
    expect(copy.restore).toBe(false);
    expect(translate("de", copy.hint, copy.values)).toBe(
      "Dieser Workflow ist deaktiviert. Aktiviere ihn, um eine Version wiederherzustellen.",
    );
  });

  test("with v3 active and v4 an open draft, restoring v2 creates v5 and the draft stays open", () => {
    const ids = { current: "version-3", draft: "version-4" };
    const view = workflowVersionView(version(2), history, ids);
    expect(view).toMatchObject({ restorable: true, nextVersion: 5, draftVersion: 4 });
    const copy = workflowVersionSheetCopy(view, { canRestore: true, archived: false });
    expect(copy.restore).toBe(true);
    expect(translate("de", copy.hint, copy.values)).toBe(
      "Wiederherstellen legt v5 mit diesem Stand an. Wächst dabei die Grenze, wartet v5 auf Freigabe. Der offene Entwurf v4 bleibt offen; gibst du ihn frei, ersetzt er v5.",
    );
    expect(translate("en", copy.hint, copy.values)).toBe(
      "Restoring creates v5 with this state. If its boundary grows, v5 waits for approval. The open draft v4 stays open; if you approve it, it replaces v5.",
    );
  });

  test("an open draft outside the loaded versions is still named as open", () => {
    const view = workflowVersionView(version(2), history, {
      current: "version-4",
      draft: "version-9",
    });
    const copy = workflowVersionSheetCopy(view, { canRestore: true, archived: false });
    expect(copy.hint).toBe("workflowVersions.restoreHintOpenDraft");
    expect(translate("de", copy.hint, copy.values)).toContain("Der offene Entwurf bleibt offen");
  });

  test("the open draft itself is not restored; it waits for its own approval", () => {
    const restored = [version(5), ...history];
    const view = workflowVersionView(version(4), restored, {
      current: "version-5",
      draft: "version-4",
    });
    expect(view).toMatchObject({ state: "draft", newest: false, restorable: false });
    const copy = workflowVersionSheetCopy(view, { canRestore: true, archived: false });
    expect(copy).toMatchObject({ restore: false, hint: "workflowVersions.draftHint" });
  });
});
