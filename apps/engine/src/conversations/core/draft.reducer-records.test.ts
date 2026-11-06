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
import type { AuthoringCheckpointKey, AuthoringCheckpointRecord } from "../types.ts";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  hasInProgressWorkflowDraft,
  startNewWorkflowDraft,
  withAuthoringFocus,
  withConnectorAuthenticated,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorPersisted,
  withConnectorProbe,
  withConnectorValidation,
  withLatestPreview,
  withWorkflowDiagnosis,
  withWorkflowDraft,
  withWorkflowExecution,
  withWorkflowInspection,
  withWorkflowPersisted,
  withWorkflowValidation,
} from "./draft.ts";

function record(
  key: AuthoringCheckpointKey,
  verified_by_tool: string,
  ok: boolean | null,
  summary: string | null,
  mutation_seq: number,
  resource_ref: AuthoringCheckpointRecord["resource_ref"] = null,
): AuthoringCheckpointRecord {
  return { key, verified_at: NOW, verified_by_tool, mutation_seq, ok, summary, resource_ref };
}

const connectorDraft = () =>
  withConnectorDraft(now, createEmptyDraftDocument(now), connector, null);
const workflowDraft = () =>
  withWorkflowDraft(now, createEmptyDraftDocument(now), workflow(1), null);

describe("connector checkpoint records", () => {
  test("inspection records an ok checkpoint and its default last action", () => {
    const draft = withConnectorInspection(now, connectorDraft());
    expect(draft.state.checkpoints.connector_inspected).toEqual(
      record(
        "connector_inspected",
        "inspect_connector_draft",
        true,
        "Connector draft inspected.",
        1,
      ),
    );
    expect(draft.summary.last_action).toBe("connector_inspected");
  });

  test("validation, authentication and probe record their tool and default last action", () => {
    const validated = withConnectorValidation(now, connectorDraft(), connector, false, "invalid");
    expect(validated.state.checkpoints.connector_validated).toEqual(
      record("connector_validated", "validate_connector_draft", false, "invalid", 1),
    );
    expect(validated.summary.last_action).toBe("connector_validated");
    const authed = withConnectorAuthenticated(now, connectorDraft(), connector, true, "a", "tool");
    expect(authed.state.checkpoints.connector_authenticated).toEqual(
      record("connector_authenticated", "tool", true, "a", 1),
    );
    expect(authed.summary.last_action).toBe("connector_authenticated");
    const probed = withConnectorProbe(now, connectorDraft(), connector, true, "probed");
    expect(probed.state.checkpoints.connector_probed).toEqual(
      record("connector_probed", "probe_connector_draft", true, "probed", 1),
    );
    expect(probed.summary.last_action).toBe("connector_probed");
  });

  test("persisting records an ok checkpoint with the resource", () => {
    const draft = withConnectorPersisted(now, connectorDraft(), connector, resource("connector"));
    expect(draft.state.checkpoints.connector_persisted).toEqual(
      record(
        "connector_persisted",
        "save_connector_draft",
        true,
        "Connector Orders API persisted.",
        1,
        {
          kind: "connector",
          id: "connector-1",
          version_id: null,
        },
      ),
    );
  });

  test("a connector mutation bumps the connector seq by one and reports missing connector fields", () => {
    const first = connectorDraft();
    expect(first.state.connector_mutation_seq).toBe(1);
    expect(withConnectorDraft(now, first, null, null).state.connector_mutation_seq).toBe(2);
    expect(first.summary.missing_fields).toEqual(["environment"]);
    expect(createEmptyDraftDocument(now).summary.missing_fields).toEqual(["workflow.steps"]);
  });
});

describe("workflow checkpoint records", () => {
  test("inspection and validation record their tool and default last action", () => {
    const inspected = withWorkflowInspection(now, workflowDraft());
    expect(inspected.state.checkpoints.workflow_inspected).toEqual(
      record("workflow_inspected", "inspect_workflow_draft", true, "Workflow draft inspected.", 1),
    );
    expect(inspected.summary.last_action).toBe("workflow_inspected");
    const validated = withWorkflowValidation(now, workflowDraft(), true, "valid");
    expect(validated.state.checkpoints.workflow_validated).toEqual(
      record("workflow_validated", "validate_draft", true, "valid", 1),
    );
    expect(validated.summary.last_action).toBe("workflow_validated");
  });

  test("an ok preview records preview and validation with the default tool", () => {
    const draft = withLatestPreview(now, workflowDraft(), { ok: true, summary: "ran" });
    expect(draft.state.checkpoints.workflow_previewed).toEqual(
      record("workflow_previewed", "dry_run_workflow", true, "ran", 1),
    );
    expect(draft.state.checkpoints.workflow_validated).toEqual(
      record(
        "workflow_validated",
        "dry_run_workflow",
        true,
        "Preview completed successfully for preparation. This grants no live execution permission.",
        1,
      ),
    );
    expect(draft.summary.blocked_by).not.toContain("dry_run_workflow");
  });

  test("persisting, binding, executing and diagnosing record ok checkpoints", () => {
    const persisted = withWorkflowPersisted(now, workflowDraft(), resource("workflow"));
    expect(persisted.state.checkpoints.workflow_persisted).toEqual(
      record(
        "workflow_persisted",
        "save_workflow_draft",
        true,
        "Workflow orders-sync persisted.",
        1,
        {
          kind: "workflow",
          id: "workflow-1",
          version_id: "version-1",
        },
      ),
    );
    expect(persisted.summary.last_action).toBe("workflow_persisted");
    const bound = bindPersistedWorkflow(now, workflowDraft(), resource("workflow"));
    expect(bound.state.checkpoints.workflow_persisted).toEqual(
      record(
        "workflow_persisted",
        "workflow_binding",
        true,
        "Saved workflow orders-sync is active.",
        1,
        {
          kind: "workflow",
          id: "workflow-1",
          version_id: "version-1",
        },
      ),
    );
    const ran = withWorkflowExecution(now, workflowDraft(), execution());
    expect(ran.state.checkpoints.workflow_executed).toEqual(
      record(
        "workflow_executed",
        "run_workflow",
        true,
        "Execution execution-1 finished with status succeeded.",
        1,
        { kind: "execution", id: "execution-1", version_id: "version-1" },
      ),
    );
    expect(ran.summary.last_action).toBe("workflow_executed");
    const diagnosed = withWorkflowDiagnosis(now, ran, diagnosis);
    expect(diagnosed.state.checkpoints.workflow_diagnosed).toEqual(
      record("workflow_diagnosed", "diagnose_latest_execution", true, diagnosis.reason, 1, {
        kind: "diagnosis",
        id: "execution-1",
        version_id: null,
      }),
    );
    expect(diagnosed.summary.last_action).toBe("workflow_diagnosed");
  });
});

describe("state carried through reducers", () => {
  test("a checkpoint keeps the latest execution and diagnosis", () => {
    const diagnosed = withWorkflowDiagnosis(
      now,
      withWorkflowExecution(now, workflowDraft(), execution()),
      diagnosis,
    );
    const inspected = withWorkflowInspection(now, diagnosed);
    expect(inspected.state.latest_execution).toEqual(execution());
    expect(inspected.state.latest_diagnosis).toEqual(diagnosis);
    expect(inspected.summary.checkpoints.map((view) => [view.key, view.status])).toContainEqual([
      "workflow_inspected",
      "fresh",
    ]);
  });

  test("persisted resources are keyed by kind and id, newest first", () => {
    const a = withConnectorPersisted(
      now,
      connectorDraft(),
      connector,
      resource("connector", { id: "a" }),
    );
    const b = withConnectorPersisted(now, a, connector, resource("connector", { id: "b" }));
    const w = withWorkflowPersisted(now, b, resource("workflow", { id: "a" }));
    expect(w.state.persisted_resources.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "workflow:a",
      "connector:b",
      "connector:a",
    ]);
    const again = withConnectorPersisted(now, w, connector, resource("connector", { id: "a" }));
    expect(again.state.persisted_resources.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "connector:a",
      "workflow:a",
      "connector:b",
    ]);
  });

  test("default last actions come from the stored summary", () => {
    const stored = withWorkflowInspection(now, workflowDraft(), "stored");
    expect(withWorkflowDraft(now, stored, workflow(2)).summary.last_action).toBe("stored");
    expect(withConnectorDraft(now, stored, connector).summary.last_action).toBe("stored");
    expect(bindPersistedWorkflow(now, stored, resource("workflow")).summary.last_action).toBe(
      "stored",
    );
    expect(withWorkflowDraft(now, { workflow: workflow(0) }, workflow(1)).summary.last_action).toBe(
      null,
    );
    expect(withConnectorDraft(now, { workflow: workflow(0) }, connector).summary.last_action).toBe(
      null,
    );
  });
});

describe("authoring modes set by reducers", () => {
  test("starting a new workflow draft and previewing select workflow authoring", () => {
    const withConnector = withConnectorDraft(now, workflowDraft(), connector, null);
    const fresh = startNewWorkflowDraft(now, withConnector);
    expect(fresh.mode).toBe("workflow_authoring");
    expect(fresh.state.workflow_mutation_seq).toBe(withConnector.state.workflow_mutation_seq + 1);
    expect(withLatestPreview(now, createEmptyDraftDocument(now), null).mode).toBe(
      "workflow_authoring",
    );
  });

  test("a connector focus selects connector authoring", () => {
    expect(withAuthoringFocus(now, workflowDraft(), "connector").mode).toBe("connector_authoring");
  });
});

describe("workflow mutations and preview traces", () => {
  test("a requested service package source wins over the stored one", () => {
    const source = (package_id: string) => ({
      package_id,
      package_version: "1",
      connector_id: "c",
      workflow_slug: "orders-sync",
      prefix: "x",
      artifact_hash: "a".repeat(64),
      definition_hash: "b".repeat(64),
    });
    const seeded = withWorkflowDraft(
      now,
      createEmptyDraftDocument(now),
      workflow(1, { service_package_source: source("old") }),
      null,
    );
    const next = withWorkflowDraft(
      now,
      seeded,
      workflow(1, { service_package_source: source("new") }),
      null,
    );
    expect(next.workflow.service_package_source).toEqual(source("new"));
  });

  test("dropping the goal alone resets the judge breaker", () => {
    const goaled = withWorkflowDraft(
      now,
      createEmptyDraftDocument(now),
      workflow(1, { goal: "g" }),
    );
    const { goal: _goal, ...withoutGoal } = goaled.workflow;
    const next = withWorkflowDraft(
      now,
      {
        ...goaled,
        state: { ...goaled.state, judge_breaker: { blocks_since_commit: 1, last_verdict: null } },
      },
      withoutGoal,
    );
    expect(next.workflow.spec).toEqual(goaled.workflow.spec);
    expect(next.state.judge_breaker).toBeNull();
  });

  test("a workflow mutation keeps unchanged traces and fills missing ones", () => {
    const draft = workflowDraft();
    const [s0] = draft.workflow.steps as [Record<string, unknown>];
    const trace = {
      step_id: "s0",
      kind: "wait",
      status: "succeeded",
      fingerprint: stepFingerprint(s0),
    };
    const previewed = withLatestPreview(now, draft, {
      ok: true,
      summary: "ok",
      step_traces: [trace],
    });
    expect(withWorkflowDraft(now, previewed, workflow(2)).latest_preview?.step_traces).toEqual([
      trace,
    ]);
    const bare = withLatestPreview(now, createEmptyDraftDocument(now), { ok: true, summary: "ok" });
    expect(withWorkflowDraft(now, bare, workflow(1)).latest_preview?.step_traces).toEqual([]);
    expect("latest_preview" in withWorkflowDraft(now, { workflow: workflow(0) }, workflow(1))).toBe(
      false,
    );
  });

  test("a first preview keeps its incoming traces and a redacted preview is stored as given", () => {
    const [s0] = workflow(1).steps as [Record<string, unknown>];
    const trace = {
      step_id: "s0",
      kind: "wait",
      status: "succeeded",
      fingerprint: stepFingerprint(s0),
    };
    const first = withLatestPreview(
      now,
      { workflow: workflow(1) },
      {
        ok: false,
        summary: "x",
        step_traces: [trace],
      },
    );
    expect(first.latest_preview?.step_traces).toEqual([trace]);
    expect(first.state.checkpoints.workflow_previewed?.redacted).toBeUndefined();
    const redactedPreview = { ok: true, summary: "r", redacted: true, step_traces: [] };
    const redacted = withLatestPreview(now, first, redactedPreview);
    expect(redacted.latest_preview).toEqual(redactedPreview);
    expect(redacted.state.checkpoints.workflow_previewed?.redacted).toBe(true);
  });
});

describe("in-progress workflow drafts", () => {
  test("only a saved workflow with the same slug ends the in-progress draft", () => {
    const drafted = workflowDraft();
    const withConnector = withConnectorPersisted(
      now,
      drafted,
      connector,
      resource("connector", { slug: "orders-sync" }),
    );
    expect(hasInProgressWorkflowDraft(withConnector)).toBe(true);
    const otherSlug = withWorkflowPersisted(now, drafted, resource("workflow", { slug: "other" }));
    expect(hasInProgressWorkflowDraft(otherSlug)).toBe(true);
    expect(
      hasInProgressWorkflowDraft(withWorkflowPersisted(now, drafted, resource("workflow"))),
    ).toBe(false);
  });
});
