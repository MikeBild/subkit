import { expect, test } from "bun:test";
import { calledWorkflowPrefix, remedyFor, repairGuidanceForIssues } from "./issue-remedies.ts";
import type { RequestBoundaryRefusal } from "./request-boundary.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

test("a storage step's blocking codes both point at the authored folder boundary", () => {
  for (const code of ["dynamic_request", "destructive_effect"] as const) {
    const remedy = remedyFor(code, "s3");
    expect(remedy).toContain("s3.scope");
    expect(remedy).toContain("key_prefix");
    expect(remedy).toContain("max_deletes");
    expect(remedy).toContain("s3.max_keys");
    expect(remedy).toContain("derived");
  }
});

test("the same code on a different driver does not borrow the storage remedy", () => {
  const http = remedyFor("dynamic_request", "http");
  expect(http).toContain('path: "/boundary"');
  expect(http).not.toContain("s3.scope");
  expect(remedyFor("dynamic_request", "postgres")).toBeNull();
  expect(remedyFor("dynamic_request", null)).toBeNull();
});

test("the report endpoint keeps its own long-standing remedy", () => {
  const report = remedyFor("dynamic_request", "http", GMAIL);
  expect(report).toContain("MIME-Version");
  expect(report).not.toContain("s3.scope");
});

test("guidance is joined over issues, so a storage problem carries its fix", () => {
  const guidance = repairGuidanceForIssues(
    [
      { step_id: "list_expired", code: "dynamic_request" },
      { step_id: "delete_expired", code: "dynamic_request" },
      { step_id: "delete_expired", code: "destructive_effect" },
    ],
    [
      { step_id: "list_expired", driver: "s3", target: "https://store.test/bucket/v1/*" },
      { step_id: "delete_expired", driver: "s3", target: "https://store.test/bucket/v1/*" },
    ],
  );
  expect(guidance.map((entry) => `${entry.step_id}:${entry.code}`)).toEqual([
    "list_expired:dynamic_request",
    "delete_expired:dynamic_request",
    "delete_expired:destructive_effect",
  ]);
});

test("a binding mismatch carries a repair that keeps graphql pagination", () => {
  const guidance = repairGuidanceForIssues(
    [{ step_id: "project_items", code: "binding_mismatch" }],
    [{ step_id: "project_items", driver: "http", target: "https://api.github.com/" }],
  );
  expect(guidance).toHaveLength(1);
  const instruction = guidance[0]?.instruction ?? "";
  expect(instruction).toContain("graphql connector");
  expect(instruction).toContain("https://api.github.com/graphql");
  expect(instruction).toContain("cursor_pagination");
  expect(instruction).toContain("REST endpoint");
  expect(instruction).toContain("POST /graphql");
  expect(remedyFor("binding_mismatch", null)).toBe(instruction);
});

test("a repeated code for one step is reported once", () => {
  const guidance = repairGuidanceForIssues(
    [
      { step_id: "purge", code: "dynamic_request" },
      { step_id: "purge", code: "dynamic_request" },
    ],
    [{ step_id: "purge", driver: "s3", target: null }],
  );
  expect(guidance).toHaveLength(1);
});

test("a step with no effect entry yields no guidance rather than a wrong one", () => {
  expect(
    repairGuidanceForIssues([{ step_id: "orphan", code: "missing_binding" }], []),
  ).toHaveLength(0);
});

test("a step that already has a scope gets the reason it was refused, not 'add a scope'", () => {
  const [entry] = repairGuidanceForIssues(
    [{ step_id: "delete_sources", code: "destructive_effect" }],
    [{ step_id: "delete_sources", driver: "s3", target: null }],
    [{ step_id: "delete_sources", reason: "delete_with_body" }],
  );
  expect(entry?.instruction).toContain("already has `s3.scope`");
  expect(entry?.instruction).toContain("for_each");
  expect(entry?.instruction).toContain("s3.key");
  expect(entry?.instruction).not.toContain("Author a fixed folder boundary");
});

test("a step with no scope still gets the generic storage remedy", () => {
  const [entry] = repairGuidanceForIssues(
    [{ step_id: "list_expired", code: "dynamic_request" }],
    [{ step_id: "list_expired", driver: "s3", target: null }],
    [{ step_id: "list_expired", reason: "no_scope" }],
  );
  expect(entry?.instruction).toContain("Author a fixed folder boundary");
});

test("the http remedy is enough on its own to author a boundary", () => {
  const remedy = remedyFor("dynamic_request", "http") ?? "";
  expect(remedy).toContain("Patch ONLY this step");
  expect(remedy).toContain("Do not re-author");
  expect(remedy).toContain("directly on the step");
  expect(remedy).toContain("WITHOUT the");
  expect(remedy).toContain("list_schedules");
  expect(remedy).toContain("max_body_bytes");
  expect(remedy).toContain("max_calls");
  expect(remedy).toContain("build the whole value in a transform");
  expect(remedy).toContain("Not coverable at all yet");
});

test("a refused request boundary gets its own reason, not 'add a boundary' again", () => {
  const guidance = (reason: RequestBoundaryRefusal) =>
    repairGuidanceForIssues(
      [{ step_id: "retire", code: "dynamic_request" }],
      [{ step_id: "retire", driver: "http", target: null }],
      [],
      [{ step_id: "retire", reason }],
    )[0]?.instruction ?? "";
  expect(guidance("variables_mismatch")).toContain("already has `boundary`");
  expect(guidance("variables_mismatch")).not.toContain("Patch ONLY this step");
  expect(guidance("query_placeholder_unsupported")).toContain("one whole placeholder");
  expect(guidance("query_placeholder_unsupported")).not.toContain("Patch ONLY this step");
  expect(guidance("delete_requires_enum")).toContain("may only vary over listed values");
  const unroutable = guidance("enum_value_unroutable");
  expect(unroutable).toContain("%2F");
  expect(unroutable).toContain("not as a separator");
  expect(remedyFor("dynamic_request", "http")).toContain("Percent-encoding is NOT a way around");
  const wholePath = guidance("variable_in_base_prefix");
  expect(wholePath).toContain("one value per segment");
  expect(wholePath).toContain("may NOT contain `/`");
  expect(guidance("stricter_profile_applies")).toContain("Do not add `boundary`");
  expect(guidance("no_boundary")).toContain("Patch ONLY this step");
});

test("a step that calls another workflow carries its remedy although it has no driver", () => {
  const [entry] = repairGuidanceForIssues(
    [{ step_id: "publish_one", code: "unbound_workflow_call" }],
    [],
  );
  expect(entry?.step_id).toBe("publish_one");
  expect(entry?.instruction).toContain("its own schedule and its own approval");
  expect(entry?.instruction).toContain("passes no `input`");
  expect(entry?.instruction).toContain("one-off run");
});

test("an unbound call names each reason and what to do about it", () => {
  const remedy = remedyFor("unbound_workflow_call", null) ?? "";
  expect(remedy).toContain("child_unavailable");
  expect(remedy).toContain("target_not_static");
  expect(remedy).toContain("child_calls_workflow");
  expect(remedy).toContain("exactly ONE fixed workflow");
  expect(remedy).toContain("`boundary` and `s3.scope` do nothing on a call step");
  expect(remedy).toContain("one-off run");
  expect(remedyFor("unbound_workflow_call", "http")).toBe(remedy);
});

test("a child's issue says which workflow to repair it in", () => {
  const prefix = calledWorkflowPrefix("run_child", "publish-essay-to-github");
  expect(prefix).toContain("publish-essay-to-github");
  expect(prefix).toContain("run_child");
  expect(prefix).toContain("Repair it THERE");
  expect(prefix).toContain("nothing in this workflow can change it");
  expect(prefix).toContain("review this workflow again");
  expect(calledWorkflowPrefix("run_child", null)).toContain("it starts");
});

test("a draft's deterministic repair is described, never offered for proposal", () => {
  const encoder = {
    code: "report_delivery_contradicted" as const,
    reason: "not_utf8" as const,
    subject: { step_id: "send_email" },
    evidence: {},
    remedy_kind: "patch" as const,
    fixer: "use_utf8_encoder" as const,
  };
  const declaration = {
    code: "execution_authority_changed" as const,
    reason: "recipient_differs" as const,
    subject: { step_id: "send_other" },
    evidence: {
      execution_id: "00000000-0000-4000-8000-000000000001",
      observed: {
        to: "ops@example.com",
        from: "ops@example.com",
        content_type: "text/html" as const,
      },
    },
    remedy_kind: "declare" as const,
    fixer: "declare_report_delivery" as const,
  };
  const issues = [{ step_id: "send_email", code: "dynamic_request" as const }];
  const effects = [{ step_id: "send_email", driver: "http" as const, target: GMAIL }];
  const guidance = (is_current: boolean) =>
    repairGuidanceForIssues(issues, effects, [], [], {
      is_current,
      diagnoses: [encoder, declaration],
    });

  const active = guidance(true);
  expect(active.map((entry) => entry.fixer)).toEqual([
    "use_utf8_encoder",
    "declare_report_delivery",
  ]);
  for (const entry of active) expect(entry.instruction).toContain("propose_workflow_repair");

  const draft = guidance(false);
  expect(draft.map((entry) => entry.step_id)).toEqual(["send_email", "send_other"]);
  for (const entry of draft) {
    expect(entry.fixer).toBeUndefined();
    expect(entry.candidate_id).toBeUndefined();
    expect(entry.instruction).not.toContain("propose_workflow_repair");
    expect(entry.instruction).toContain("draft");
  }
  expect(draft[0]?.instruction).toContain("sk.base64UrlEncodeUtf8(");
  expect(draft[1]?.instruction).toContain("report_delivery");
});
