import { describe, expect, test } from "bun:test";
import { translate } from "./i18n";
import {
  humaniseToolName,
  isStaleCall,
  isWorkflowRunTool,
  STALE_AFTER_MS,
  toolLabel,
  toolOutcomeKey,
  toolTier,
  workflowRefusalKey,
  workflowRunKind,
  workflowRunTitleKey,
  workflowSlugFromTool,
} from "./tool-presentation";

describe("toolLabel", () => {
  test("passes a saved workflow's own name through instead of mangling it", () => {
    expect(toolLabel("wf_ga4-daily-report")).toEqual({
      kind: "workflow",
      slug: "ga4-daily-report",
    });
  });

  test("names a registered read and a registered action from the catalog", () => {
    expect(toolLabel("list_workflows")).toEqual({
      kind: "background",
      words: {
        active: "tool.background.listWorkflows.active",
        past: "tool.background.listWorkflows.past",
      },
    });
    expect(toolLabel("run_workflow")).toEqual({ kind: "key", key: "tool.name.runWorkflow" });
    expect(toolLabel("inspect_playbook")).toEqual({
      kind: "background",
      words: {
        active: "tool.background.inspectPlaybook.active",
        past: "tool.background.inspectPlaybook.past",
      },
    });
    expect(toolLabel("update_playbook")).toEqual({
      kind: "background",
      words: {
        active: "tool.background.updatePlaybook.active",
        past: "tool.background.updatePlaybook.past",
      },
    });
    expect(translate("de", "tool.background.updatePlaybook.past")).toBe("Playbook aktualisiert");
    expect(translate("en", "tool.background.inspectPlaybook.past")).toBe("Playbook reviewed");
  });

  test("labels a skill write by its outcome, so a queued proposal never reads as created", () => {
    expect(
      toolLabel("create_skill", { ok: true, data: { created: false, action: "proposed" } }),
    ).toEqual({ kind: "key", key: "tool.name.proposeSkill" });
    expect(
      toolLabel("create_skill", { ok: true, data: { created: false, action: "updated" } }),
    ).toEqual({ kind: "key", key: "tool.name.proposeSkill" });
    expect(translate("de", "tool.name.proposeSkill")).toBe("Skill vorgeschlagen");
    expect(translate("en", "tool.name.proposeSkill")).toBe("Proposed a skill");
    expect(toolLabel("create_skill")).toEqual({ kind: "key", key: "tool.name.createSkill" });
  });

  test("falls back to a readable literal for a name nobody registered", () => {
    expect(toolLabel("some_future_tool")).toEqual({
      kind: "literal",
      text: "Some Future Tool",
    });
  });
});

describe("humaniseToolName", () => {
  test("reads an unregistered snake_case name as words", () => {
    expect(humaniseToolName("list_open_invoices")).toBe("List Open Invoices");
  });
});

describe("toolTier", () => {
  test("a read is background, a run is an action", () => {
    expect(toolTier("list_workflows")).toBe("background");
    expect(toolTier("run_workflow")).toBe("action");
  });

  test("an unknown action gets a card — over-showing beats hiding", () => {
    expect(toolTier("some_future_tool")).toBe("action");
  });

  test("a saved workflow is always an action, never a background line", () => {
    expect(toolTier("wf_ga4-daily-report")).toBe("action");
  });
});

describe("workflowSlugFromTool", () => {
  test("returns null for a bare prefix and for a normal tool", () => {
    expect(workflowSlugFromTool("wf_")).toBeNull();
    expect(workflowSlugFromTool("run_workflow")).toBeNull();
  });
});

describe("toolOutcomeKey", () => {
  test("a human decision outranks the machine result", () => {
    expect(toolOutcomeKey({ confirmationState: "declined", outcome: "error" })).toBe(
      "tool.outcome.declined",
    );
  });

  test("a lost call reads as unfinished regardless of what else is set", () => {
    expect(toolOutcomeKey({ confirmationState: "confirmed", outcome: "ok", stale: true })).toBe(
      "tool.outcome.didNotComplete",
    );
  });

  test("falls through to the part's own state when the engine recorded neither", () => {
    expect(toolOutcomeKey({ confirmationState: null, outcome: null })).toBeNull();
  });

  test("every word it can return exists in both catalogs", () => {
    const states = [
      "proposed",
      "tested",
      "confirmed",
      "partial",
      "declined",
      "auto_declined",
      "oauth_success",
      "oauth_failure",
    ];
    const outcomes = ["ok", "error", "denied", "pending"];
    for (const confirmationState of states) {
      const key = toolOutcomeKey({ confirmationState });
      expect(key).not.toBeNull();
      if (!key) continue;
      for (const locale of ["en", "de"] as const) expect(translate(locale, key)).toBeTruthy();
    }
    for (const outcome of outcomes) {
      const key = toolOutcomeKey({ outcome });
      expect(key).not.toBeNull();
      if (!key) continue;
      for (const locale of ["en", "de"] as const) expect(translate(locale, key)).toBeTruthy();
    }
  });
});

describe("isStaleCall", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  test("a call with no result older than the window is presumed lost", () => {
    const old = new Date(now - STALE_AFTER_MS - 1000).toISOString();
    expect(isStaleCall({ messageCreatedAt: old, hasResult: false, isStreaming: false, now })).toBe(
      true,
    );
  });

  test("a live turn is never stale, however long it has been running", () => {
    const old = new Date(now - STALE_AFTER_MS * 10).toISOString();
    expect(isStaleCall({ messageCreatedAt: old, hasResult: false, isStreaming: true, now })).toBe(
      false,
    );
  });

  test("a finished call is never stale", () => {
    const old = new Date(now - STALE_AFTER_MS * 10).toISOString();
    expect(isStaleCall({ messageCreatedAt: old, hasResult: true, isStreaming: false, now })).toBe(
      false,
    );
  });

  test("an unreadable or missing timestamp does not accuse a call of being lost", () => {
    expect(
      isStaleCall({ messageCreatedAt: "not a date", hasResult: false, isStreaming: false, now }),
    ).toBe(false);
    expect(isStaleCall({ messageCreatedAt: null, hasResult: false, isStreaming: false, now })).toBe(
      false,
    );
  });
});

describe("what a workflow call really was", () => {
  const trial = {
    ok: false,
    data: {
      execution_id: "00000000-0000-4000-8000-0000000000e1",
      hold_writes: true,
      writes_held: true,
      held_step_ids: ["send_email"],
      status: "failed",
    },
  };
  const live = {
    ok: true,
    data: {
      execution_id: "00000000-0000-4000-8000-0000000000e2",
      hold_writes: false,
      execution_authority_id: "00000000-0000-4000-8000-0000000000a1",
      status: "succeeded",
    },
  };
  const refused = {
    ok: false,
    data: { error_code: "workflow_activation_required", status: "failed" },
  };
  const heldPreview = {
    ok: false,
    status: "succeeded",
    execution_id: "00000000-0000-4000-8000-0000000000e3",
    hold_writes: true,
    preview: true,
    writes_held: true,
    pending: true,
  };

  test("a preparation with every write held is a trial, whatever its status", () => {
    expect(workflowRunKind(trial)).toBe("trial");
    expect(workflowRunKind({ ok: true, data: { ...trial.data, status: "succeeded" } })).toBe(
      "trial",
    );
    expect(workflowRunKind(heldPreview)).toBe("trial");
  });

  test("a run with its writes dispatched is a run", () => {
    expect(workflowRunKind(live)).toBe("live");
    expect(workflowRunKind({ ...live.data, ok: true })).toBe("live");
  });

  test("a call the engine turned away before anything started is a refusal", () => {
    expect(workflowRunKind(refused)).toBe("refused");
    expect(workflowRunKind({ ok: false, denied: true, permission: "workflow:run" })).toBe(
      "refused",
    );
    expect(workflowRunKind({ ok: false, data: { error: "workflow_not_found" } })).toBe("refused");
  });

  test("a call without a result to read is not judged", () => {
    expect(workflowRunKind(undefined)).toBeNull();
    expect(workflowRunKind(null)).toBeNull();
    expect(workflowRunKind("pending")).toBeNull();
    expect(workflowRunKind({})).toBeNull();
  });

  test("the title says trial, refusal or run — never 'ran' over a trial", () => {
    const generic = toolLabel("run_workflow");
    const named = toolLabel("wf_finding-triage");
    const title = (label: typeof generic, kind: ReturnType<typeof workflowRunKind>) => {
      const key = workflowRunTitleKey(label, false, kind);
      return key ? translate("de", key, { name: "finding-triage" }) : null;
    };
    expect(title(generic, "trial")).toBe("Probelauf ohne Wirkung");
    expect(title(generic, "refused")).toBe("Lauf abgelehnt");
    expect(title(generic, "live")).toBe("Workflow ausgeführt");
    expect(title(named, "trial")).toBe("Probelauf von „finding-triage“ ohne Wirkung");
    expect(title(named, "refused")).toBe("Lauf von „finding-triage“ abgelehnt");
    expect(title(named, "live")).toBe("Workflow „finding-triage“ ausgeführt");
    expect(title(generic, null)).toBe("Workflow ausgeführt");
    expect(translate("en", "tool.name.runWorkflow.trial")).toBe("Trial run without effects");
    expect(translate("en", "tool.name.runWorkflow.refused")).toBe("Run refused");
  });

  test("a person's or a permission's no outranks what the payload says", () => {
    expect(workflowRunTitleKey(toolLabel("run_workflow"), true, "trial")).toBe(
      "tool.name.runWorkflow.notRun",
    );
    expect(workflowRunTitleKey(toolLabel("wf_report"), true, "live")).toBe(
      "tool.name.runNamedWorkflow.notRun",
    );
  });

  test("any other action keeps its own name", () => {
    expect(workflowRunTitleKey(toolLabel("update_workflow"), false, "refused")).toBeNull();
    expect(workflowRunTitleKey(toolLabel("search_knowledge"), false, null)).toBeNull();
    expect(isWorkflowRunTool("run_workflow")).toBe(true);
    expect(isWorkflowRunTool("wf_report")).toBe(true);
    expect(isWorkflowRunTool("dry_run_workflow")).toBe(false);
    expect(isWorkflowRunTool("update_workflow")).toBe(false);
  });

  test("a refusal carries the engine's reason in the reader's words", () => {
    expect(workflowRefusalKey(refused)).toBe("tool.refusal.activationRequired");
    expect(translate("de", "tool.refusal.activationRequired")).toBe(
      "Entwurf noch nicht übernommen",
    );
    expect(workflowRefusalKey({ ok: false, denied: true })).toBe("tool.refusal.permission");
    expect(workflowRefusalKey({ ok: false, data: { error_code: "permission_denied" } })).toBe(
      "tool.refusal.permission",
    );
    const legacy = {
      ok: false,
      data: { error_code: "workflow_version_invalid", status: "failed" },
    };
    expect(workflowRunKind(legacy)).toBe("refused");
    expect(translate("de", workflowRefusalKey(legacy) ?? "tool.outcome.foundIssue")).toBe(
      "Version in älterem Format gespeichert",
    );
    expect(workflowRefusalKey({ ok: false, data: { error_code: "run_failed" } })).toBeNull();
    expect(workflowRefusalKey(undefined)).toBeNull();
  });

  test("every reason word exists in both catalogs", () => {
    for (const code of [
      "workflow_activation_required",
      "workflow_version_invalid",
      "workflow_not_persisted",
      "workflow_not_found",
      "permission_denied",
      "repair_loop_detected",
      "input_schema_violation",
      "execution_authority_unavailable",
    ]) {
      const key = workflowRefusalKey({ ok: false, data: { error_code: code } });
      expect(key, code).not.toBeNull();
      if (!key) continue;
      for (const locale of ["de", "en"] as const)
        expect(translate(locale, key), code).not.toBe(key);
    }
  });
});
