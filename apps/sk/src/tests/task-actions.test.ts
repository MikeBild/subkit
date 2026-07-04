import { describe, expect, test } from "bun:test";
import {
  findTaskActionById,
  resolveTaskActionSuggestion,
  searchTaskActions,
  starterTaskActionsForPersona,
  TASK_ACTIONS,
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

describe("triage-digest-failures TaskAction", () => {
  test("action exists in the TASK_ACTIONS catalog", () => {
    const action = TASK_ACTIONS.find((a) => a.id === "triage-digest-failures");
    expect(action).toBeDefined();
  });

  test("invoke.kind is 'prompt' (not slash or builtin)", () => {
    const action = findTaskActionById("triage-digest-failures");
    expect(action?.invoke.kind).toBe("prompt");
  });

  test("invoke.prompt is non-empty and references triage / digest", () => {
    const action = findTaskActionById("triage-digest-failures");
    expect(action?.invoke.kind).toBe("prompt");
    if (action?.invoke.kind === "prompt") {
      expect(action.invoke.prompt.length).toBeGreaterThan(0);
      // The prompt must direct the LLM toward the digest content, not invent issues
      expect(action.invoke.prompt).toContain("digest");
    }
  });

  test("action has 'conversation:write' permission requirement", () => {
    const action = findTaskActionById("triage-digest-failures");
    expect(action?.requires).toBe("conversation:write");
  });

  test("action is findable by its 'triage' alias", () => {
    const found = resolveTaskActionSuggestion("triage");
    expect(found?.id).toBe("triage-digest-failures");
  });

  test("action is findable by 'fix failures' alias", () => {
    const found = resolveTaskActionSuggestion("fix failures");
    expect(found?.id).toBe("triage-digest-failures");
  });

  test("action is hidden from an enduser persona lacking conversation:write", () => {
    const noWrite: PersonaProbe = {
      allows: (permission) => new Set(["conversation:read", "conversation:list"]).has(permission),
    };
    const visible = taskActionsForPersona(noWrite).map((action) => action.id);
    expect(visible).not.toContain("triage-digest-failures");
  });

  test("action is visible to a persona with conversation:write", () => {
    const withWrite: PersonaProbe = {
      allows: (permission) => new Set(["conversation:read", "conversation:write"]).has(permission),
    };
    const visible = taskActionsForPersona(withWrite).map((action) => action.id);
    expect(visible).toContain("triage-digest-failures");
  });
});
