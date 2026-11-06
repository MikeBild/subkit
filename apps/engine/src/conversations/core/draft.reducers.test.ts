import { describe, expect, test } from "bun:test";
import { stepFingerprint } from "../step-fingerprint.ts";
import {
  connector,
  diagnosis,
  execution,
  NOW,
  now,
  resource,
  workflow,
} from "../tests/draft-fixtures.ts";
import type { DraftDocument } from "../types.ts";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  getWorkflowDraft,
  hasInProgressWorkflowDraft,
  startNewWorkflowDraft,
  WORKFLOW_BINDING_TOOL,
  withAuthoringFocus,
  withConnectorAuthenticated,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorPersisted,
  withConnectorProbe,
  withConnectorValidation,
  withFocusedExecution,
  withJudgeBreaker,
  withLatestPreview,
  withWorkflowDiagnosis,
  withWorkflowDraft,
  withWorkflowExecution,
  withWorkflowInspection,
  withWorkflowPersisted,
  withWorkflowSaveError,
} from "./draft.ts";

describe("workflow reducers", () => {
  test("getWorkflowDraft returns the normalized workflow", () => {
    expect(getWorkflowDraft(now, { workflow: workflow(2) })).toEqual(workflow(2));
  });

  test("withWorkflowDraft bumps the mutation seq only on change and clears the save error", () => {
    const first = withWorkflowSaveError(
      now,
      withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(1), "a"),
      {
        code: "draft_conflict",
        message: "x".repeat(1_200),
      },
    );
    expect(first.state?.latest_workflow_save_error?.message).toHaveLength(1_000);
    expect(first.summary?.last_action).toBe("workflow_save_conflict");
    const same = withWorkflowDraft(now, first, workflow(1), "b");
    expect(same.state?.workflow_mutation_seq).toBe(first.state?.workflow_mutation_seq);
    expect(same.state?.latest_workflow_save_error).not.toBeNull();
    const changed = withWorkflowDraft(now, first, workflow(2), "c");
    expect(changed.state?.workflow_mutation_seq).toBe(
      (first.state?.workflow_mutation_seq ?? 0) + 1,
    );
    expect(changed.state?.latest_workflow_save_error).toBeNull();
    expect(changed.state?.stage).toBeDefined();
  });

  test("withWorkflowDraft targets an empty workflow without steps", () => {
    const draft = withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(0), null);
    expect(draft.mode).toBe("workflow_authoring");
    expect(draft.summary?.last_action).toBeNull();
  });

  test("withWorkflowDraft carries the service package source when the request omits it", () => {
    const service_package_source = {
      package_id: "p",
      package_version: "1",
      connector_id: "c",
      workflow_slug: "orders-sync",
      prefix: "x",
      artifact_hash: "a".repeat(64),
      definition_hash: "b".repeat(64),
    };
    const seeded = withWorkflowDraft(
      now,
      createEmptyDraftDocument(now),
      workflow(1, { service_package_source }),
      null,
    );
    const next = withWorkflowDraft(now, seeded, workflow(2), null);
    expect(next.workflow.service_package_source).toEqual(service_package_source);
  });

  test("withWorkflowDraft resets the judge breaker only when goal or spec change", () => {
    const base = withJudgeBreaker(
      now,
      withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(1, { goal: "g" }), null),
      { blocks_since_commit: 2 },
    );
    expect(
      withWorkflowDraft(now, base, { ...base.workflow, steps: workflow(2).steps }, null).state
        ?.judge_breaker,
    ).toEqual({ blocks_since_commit: 2, last_verdict: null });
    expect(
      withWorkflowDraft(now, base, workflow(2, { goal: "g" }), null).state?.judge_breaker,
    ).toBeNull();
    expect(
      withWorkflowDraft(now, base, workflow(1, { goal: "h" }), null).state?.judge_breaker,
    ).toBeNull();
    expect(withJudgeBreaker(now, base, null).state?.judge_breaker).toBeNull();
  });

  test("withWorkflowDraft prunes preview traces of steps that changed", () => {
    const previewed = withLatestPreview(
      now,
      withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(1), null),
      {
        ok: true,
        summary: "ok",
        step_traces: [{ step_id: "s0", kind: "wait", status: "succeeded" }],
      },
    );
    const next = withWorkflowDraft(now, previewed, workflow(0), null);
    expect(next.latest_preview?.step_traces).toEqual([]);
  });

  test("hasInProgressWorkflowDraft is true only for unsaved drafts with steps", () => {
    expect(hasInProgressWorkflowDraft(createEmptyDraftDocument(now))).toBe(false);
    const drafted = withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(1), null);
    expect(hasInProgressWorkflowDraft(drafted)).toBe(true);
    expect(
      hasInProgressWorkflowDraft(withWorkflowPersisted(now, drafted, resource("workflow"))),
    ).toBe(false);
    expect(hasInProgressWorkflowDraft({ workflow: workflow(1) })).toBe(true);
    expect(hasInProgressWorkflowDraft({} as DraftDocument)).toBe(false);
  });

  test("startNewWorkflowDraft drops workflow checkpoints and resources", () => {
    const saved = withWorkflowPersisted(
      now,
      withWorkflowInspection(
        now,
        withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(1), null),
      ),
      resource("workflow"),
    );
    const fresh = startNewWorkflowDraft(
      now,
      withConnectorPersisted(now, saved, connector, resource("connector")),
    );
    expect(fresh.workflow).toEqual({ name: "new-workflow", steps: [] });
    expect(fresh.state?.persisted_resources.map((r) => r.kind)).toEqual(["connector"]);
    expect(Object.keys(fresh.state?.checkpoints ?? {})).toEqual(["connector_persisted"]);
    expect(fresh.summary?.last_action).toBe("workflow_target_reset");
  });
});

describe("connector reducers", () => {
  test("withConnectorDraft enters connector authoring and clears it again", () => {
    const withConnector = withConnectorDraft(
      now,
      createEmptyDraftDocument(now, "workflow_authoring"),
      connector,
      "set",
    );
    expect(withConnector.mode).toBe("connector_authoring");
    const cleared = withConnectorDraft(now, withConnector, null, null);
    expect(cleared.connector).toBeNull();
    expect(cleared.mode).toBe("connector_authoring");
    const noMode = withConnectorDraft(now, { workflow: workflow(0) }, null, null);
    expect(noMode.mode).toBe("onboarding");
  });

  test("records each connector checkpoint with its tool and the injected clock", () => {
    let draft = withConnectorDraft(now, createEmptyDraftDocument(now), connector, null);
    draft = withConnectorInspection(now, draft);
    draft = withConnectorValidation(now, draft, connector, true, "valid");
    draft = withConnectorAuthenticated(now, draft, connector, true, "authed", "authenticate_oauth");
    draft = withConnectorProbe(now, draft, connector, false, "probe failed");
    draft = withConnectorPersisted(now, draft, connector, resource("connector", { name: null }));
    const checkpoints = draft.state?.checkpoints ?? {};
    expect(checkpoints.connector_inspected?.verified_by_tool).toBe("inspect_connector_draft");
    expect(checkpoints.connector_validated?.verified_by_tool).toBe("validate_connector_draft");
    expect(checkpoints.connector_authenticated?.verified_by_tool).toBe("authenticate_oauth");
    expect(checkpoints.connector_probed?.ok).toBe(false);
    expect(checkpoints.connector_persisted?.summary).toBe("Connector connector-1 persisted.");
    expect(checkpoints.connector_persisted?.resource_ref).toEqual({
      kind: "connector",
      id: "connector-1",
      version_id: null,
    });
    expect(checkpoints.connector_persisted?.verified_at).toBe(NOW);
    expect(draft.summary?.last_action).toBe("connector_persisted");
  });

  test("persisting the same resource twice keeps one entry", () => {
    const once = withConnectorPersisted(
      now,
      createEmptyDraftDocument(now),
      connector,
      resource("connector"),
    );
    const twice = withConnectorPersisted(now, once, connector, resource("connector"));
    expect(twice.state?.persisted_resources).toHaveLength(1);
  });

  test("withAuthoringFocus switches focus and can drop the connector", () => {
    const draft = withConnectorDraft(now, createEmptyDraftDocument(now), connector, null);
    const connectorFocus = withAuthoringFocus(now, draft, "connector");
    expect(connectorFocus.state?.authoring_focus).toBe("connector");
    expect(connectorFocus.mode).toBe("connector_authoring");
    const workflowFocus = withAuthoringFocus(now, draft, "workflow", { dropConnector: true });
    expect(workflowFocus.connector).toBeNull();
    expect(workflowFocus.state?.authoring_focus).toBeNull();
    expect(workflowFocus.mode).toBe("workflow_authoring");
  });
});

describe("preview reducer", () => {
  const base = () => withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(2), null);

  test("records a failed preview without validating", () => {
    const draft = withLatestPreview(now, base(), { ok: false, summary: "failed" });
    expect(draft.state?.checkpoints.workflow_previewed?.ok).toBe(false);
    expect(draft.state?.checkpoints.workflow_validated).toBeUndefined();
    expect(draft.summary?.last_action).toBe("workflow_previewed");
  });

  test("a null preview records a failed checkpoint with the default summary", () => {
    const draft = withLatestPreview(now, base(), null, "dry_run_step", "custom");
    expect(draft.latest_preview).toBeNull();
    expect(draft.state?.checkpoints.workflow_previewed).toMatchObject({
      ok: false,
      summary: "Workflow preview recorded.",
      verified_by_tool: "dry_run_step",
    });
    expect(draft.summary?.last_action).toBe("custom");
  });

  test("validation summary depends on redaction and warnings", () => {
    const plain = withLatestPreview(now, base(), { ok: true, summary: "ok" });
    expect(plain.state?.checkpoints.workflow_validated?.summary).toContain(
      "Preview completed successfully",
    );
    const warned = withLatestPreview(now, base(), {
      ok: true,
      summary: "ok",
      warnings: [{ code: "w" }],
    });
    expect(warned.state?.checkpoints.workflow_validated?.summary).toContain("with warnings");
    const redacted = withLatestPreview(now, base(), { ok: true, summary: "ok", redacted: true });
    expect(redacted.state?.checkpoints.workflow_validated?.summary).toContain("Structure checked");
    expect(redacted.state?.checkpoints.workflow_previewed?.redacted).toBe(true);
  });

  test("merges fingerprint-valid traces with incoming ones and keeps an empty merge as given", () => {
    const draft = base();
    const [s0, s1] = draft.workflow.steps as [Record<string, unknown>, Record<string, unknown>];
    const first = withLatestPreview(now, draft, {
      ok: true,
      summary: "ok",
      step_traces: [
        { step_id: "s0", kind: "wait", status: "succeeded", fingerprint: stepFingerprint(s0) },
        { step_id: "s1", kind: "wait", status: "succeeded", fingerprint: stepFingerprint(s1) },
        { step_id: "gone", kind: "wait", status: "succeeded", fingerprint: "stale" },
      ],
    });
    const second = withLatestPreview(now, first, {
      ok: true,
      summary: "ok",
      step_traces: [{ step_id: "s1", kind: "wait", status: "failed" }],
    });
    expect(second.latest_preview?.step_traces).toEqual([
      { step_id: "s0", kind: "wait", status: "succeeded", fingerprint: stepFingerprint(s0) },
      { step_id: "s1", kind: "wait", status: "failed" },
    ]);
    const empty = withLatestPreview(now, createEmptyDraftDocument(now), {
      ok: true,
      summary: "ok",
    });
    expect(empty.latest_preview?.step_traces).toBeUndefined();
  });
});

describe("persistence and execution reducers", () => {
  test("withWorkflowPersisted words draft and active saves differently", () => {
    const draftSave = withWorkflowPersisted(
      now,
      createEmptyDraftDocument(now),
      resource("workflow", { persistence_kind: "draft" }),
    );
    expect(draftSave.state?.checkpoints.workflow_persisted?.summary).toBe(
      "Workflow draft orders-sync saved; activation is still required.",
    );
    expect(draftSave.state?.checkpoints.workflow_persisted?.verified_by_tool).toBe(
      "save_workflow_draft",
    );
    const activeSave = withWorkflowPersisted(
      now,
      createEmptyDraftDocument(now),
      resource("workflow", { name: null }),
    );
    expect(activeSave.state?.checkpoints.workflow_persisted?.summary).toBe(
      "Workflow workflow-1 persisted.",
    );
  });

  test("bindPersistedWorkflow picks the surface mode and default wording", () => {
    const plain = bindPersistedWorkflow(now, createEmptyDraftDocument(now), resource("workflow"));
    expect(plain.state?.checkpoints.workflow_persisted).toMatchObject({
      verified_by_tool: WORKFLOW_BINDING_TOOL,
      summary: "Saved workflow orders-sync is active.",
      resource_ref: { kind: "workflow", id: "workflow-1", version_id: "version-1" },
    });
    expect(plain.summary?.last_action).toBeNull();
    const draftBinding = bindPersistedWorkflow(
      now,
      createEmptyDraftDocument(now),
      resource("workflow", { persistence_kind: "draft", name: null }),
    );
    expect(draftBinding.state?.checkpoints.workflow_persisted?.summary).toBe(
      "Workflow draft workflow-1 saved; activation is still required.",
    );
    const executed = withWorkflowExecution(now, createEmptyDraftDocument(now), execution());
    expect(
      bindPersistedWorkflow(now, executed, resource("workflow"), { summary: null }).state
        ?.checkpoints.workflow_persisted?.summary,
    ).toBe("Saved workflow orders-sync is active.");
    const diagnosed = withWorkflowDiagnosis(now, executed, diagnosis);
    const bound = bindPersistedWorkflow(now, diagnosed, resource("workflow"), {
      tool_name: "t",
      summary: "s",
      last_action: "l",
    });
    expect(bound.state?.checkpoints.workflow_persisted).toMatchObject({
      verified_by_tool: "t",
      summary: "s",
    });
    expect(bound.summary?.last_action).toBe("l");
  });

  test("withWorkflowExecution records the outcome and clears a stale diagnosis when one is available", () => {
    const diagnosed = withWorkflowDiagnosis(now, createEmptyDraftDocument(now), diagnosis);
    expect(diagnosed.state?.checkpoints.workflow_diagnosed?.summary).toBe(diagnosis.reason);
    const ran = withWorkflowExecution(
      now,
      diagnosed,
      execution({ status: "failed", diagnosis_available: true }),
    );
    expect(ran.state?.latest_diagnosis).toBeNull();
    expect(ran.state?.checkpoints.workflow_executed).toMatchObject({
      ok: false,
      summary: "Execution execution-1 finished with status failed.",
      resource_ref: { kind: "execution", id: "execution-1", version_id: "version-1" },
    });
    const ok = withWorkflowExecution(now, diagnosed, execution());
    expect(ok.state?.latest_diagnosis).not.toBeNull();
    expect(ok.state?.checkpoints.workflow_executed?.ok).toBe(true);
  });

  test("withFocusedExecution focuses an execution without a checkpoint", () => {
    const focused = withFocusedExecution(
      now,
      withWorkflowDiagnosis(now, createEmptyDraftDocument(now), diagnosis),
      execution(),
    );
    expect(focused.state?.latest_execution?.execution_id).toBe("execution-1");
    expect(focused.state?.latest_diagnosis).toBeNull();
    expect(focused.state?.checkpoints.workflow_executed).toBeUndefined();
    expect(focused.summary?.last_action).toBe("execution_focused");
  });
});
