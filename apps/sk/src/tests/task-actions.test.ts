import { describe, expect, test } from "bun:test";
import {
  resolveTaskActionSuggestion,
  searchTaskActions,
  starterTaskActionsForPersona,
  taskActionsForContext,
  taskActionsForPersona,
} from "../repl/task-actions.ts";
import type { PersonaProbe } from "../slash.ts";

const allowAll: PersonaProbe = { allows: () => true };
const endUser: PersonaProbe = {
  allows: (permission) =>
    new Set(["conversation:read", "conversation:write", "conversation:list"]).has(permission),
};

describe("task action catalog", () => {
  test("starter actions preserve the first-run numeric contract", () => {
    const actions = starterTaskActionsForPersona("admin", allowAll);
    expect(actions.map((action) => action.key)).toEqual(["1", "2", "3", "4", "5"]);
    expect(actions.map((action) => action.id)).toEqual([
      "resume-recent",
      "create-connector",
      "build-workflow",
      "inspect-tenant",
      "surface-help",
    ]);
  });

  test("portal/enduser swaps tenant inspection for accessible work", () => {
    const actions = starterTaskActionsForPersona("portal", endUser);
    expect(actions[3]?.id).toBe("check-accessible-work");
  });

  test("persona filter hides actions without granted permissions", () => {
    const visible = taskActionsForPersona(endUser).map((action) => action.id);
    expect(visible).toContain("build-workflow");
    expect(visible).toContain("show-context");
    expect(visible).not.toContain("setup-readiness");
    expect(visible).not.toContain("connector-onboarding");
  });

  test("next-best-action strings resolve to stable catalog actions", () => {
    expect(resolveTaskActionSuggestion("repair")?.id).toBe("repair-failed-run");
    expect(resolveTaskActionSuggestion("/approvals")?.id).toBe("show-approvals");
    expect(resolveTaskActionSuggestion("unknown action")).toBeUndefined();
  });

  test("launcher search matches aliases and descriptions", () => {
    const matches = searchTaskActions("diagnose", taskActionsForPersona(allowAll));
    expect(matches[0]?.id).toBe("repair-failed-run");
  });

  test("context filter hides draft-only actions until a matching target exists", () => {
    expect(taskActionsForContext(allowAll).map((action) => action.id)).not.toContain(
      "preview-draft",
    );
    const visible = taskActionsForContext(allowAll, {
      resumeSummary: {
        active_target: { kind: "workflow" },
        last_successful_preview: null,
      },
    }).map((action) => action.id);
    expect(visible).toContain("preview-draft");
    expect(visible).not.toContain("probe-draft");
  });
});
