// An issue code without a remedy is a diagnosis the reader has to guess at.
//
// These pin the mapping that closed a real failure: asked to bound a retention
// workflow's removals, the authoring model diagnosed `dynamic_request` on two
// s3 steps correctly, received an empty guidance list, and invented a remedy
// out of `s3.max_keys` — a field that exists but is derived from the step, not
// authored. The remedy now travels with the diagnosis, and it names that trap
// by name.

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
    // The exact invention this exists to prevent.
    expect(remedy).toContain("s3.max_keys");
    expect(remedy).toContain("derived");
  }
});

test("the same code on a different driver does not borrow the storage remedy", () => {
  // An HTTP step has its own remedy — the authored `boundary` — and must never be
  // told to declare a storage folder.
  const http = remedyFor("dynamic_request", "http");
  expect(http).toContain('path: "/boundary"');
  expect(http).not.toContain("s3.scope");
  expect(remedyFor("dynamic_request", "postgres")).toBeNull();
  // An unknown driver (a step the compiler skipped before binding) yields
  // nothing rather than a confidently wrong instruction.
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
  // `missing_binding` steps never reach `effects` — the compiler skips them —
  // so the driver is unknowable here and silence is the honest answer.
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
  // The generic remedy would send the author in a circle.
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
  // Patch, do not rewrite — a repair once regenerated a whole saved workflow.
  expect(remedy).toContain("Patch ONLY this step");
  expect(remedy).toContain("Do not re-author");
  // Where it goes, how variables are keyed, and where the values come from.
  expect(remedy).toContain("directly on the step");
  expect(remedy).toContain("WITHOUT the");
  expect(remedy).toContain("list_schedules");
  expect(remedy).toContain("max_body_bytes");
  expect(remedy).toContain("max_calls");
  // What needs a minimal re-author, and what it cannot do at all, so the
  // author neither gives up too early nor tries the impossible.
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
  // A query value can vary now, but only as one whole placeholder; the remedy
  // names that form instead of sending the author back to "add a boundary".
  expect(guidance("query_placeholder_unsupported")).toContain("one whole placeholder");
  expect(guidance("query_placeholder_unsupported")).not.toContain("Patch ONLY this step");
  expect(guidance("delete_requires_enum")).toContain("may only vary over listed values");
  // A placeholder standing for the whole path needs one value per segment,
  // not just "put it after the literals".
  // Encoding a slash is not a way around the one-segment rule: it addresses
  // something else. The capability to hold `%XX` values invited exactly that.
  const unroutable = guidance("enum_value_unroutable");
  expect(unroutable).toContain("%2F");
  expect(unroutable).toContain("not as a separator");
  expect(remedyFor("dynamic_request", "http")).toContain("Percent-encoding is NOT a way around");
  const wholePath = guidance("variable_in_base_prefix");
  expect(wholePath).toContain("one value per segment");
  expect(wholePath).toContain("may NOT contain `/`");
  // Some steps cannot be covered at all yet — the honest answer is "do not try".
  expect(guidance("stricter_profile_applies")).toContain("Do not add `boundary`");
  // The generic case keeps the generic remedy.
  expect(guidance("no_boundary")).toContain("Patch ONLY this step");
});

test("a step that calls another workflow carries its remedy although it has no driver", () => {
  // A `call` step never becomes an effect, so there is no driver to key on.
  // Registered under a driver, this remedy could not be reached and the issue
  // arrived bare.
  const [entry] = repairGuidanceForIssues(
    [{ step_id: "publish_one", code: "unbound_workflow_call" }],
    [],
  );
  expect(entry?.step_id).toBe("publish_one");
  expect(entry?.instruction).toContain("its own schedule and its own approval");
  // The discriminator, so the reader can tell which of the two ways applies.
  expect(entry?.instruction).toContain("passes no `input`");
  expect(entry?.instruction).toContain("one-off run");
});

test("an unbound call names each reason and what to do about it", () => {
  // One code, three very different situations. A remedy that named only the
  // generic case sent the author looking for a fix that did not apply.
  const remedy = remedyFor("unbound_workflow_call", null) ?? "";
  expect(remedy).toContain("child_unavailable");
  expect(remedy).toContain("target_not_static");
  expect(remedy).toContain("child_calls_workflow");
  // The three traps: guessing, widening, and substituting a single run.
  expect(remedy).toContain("exactly ONE fixed workflow");
  expect(remedy).toContain("`boundary` and `s3.scope` do nothing on a call step");
  expect(remedy).toContain("one-off run");
  // A driver-keyed registration would make this unreachable: a call step
  // never becomes an effect, so it has no driver.
  expect(remedyFor("unbound_workflow_call", "http")).toBe(remedy);
});

test("a child's issue says which workflow to repair it in", () => {
  const prefix = calledWorkflowPrefix("run_child", "publish-essay-to-github");
  expect(prefix).toContain("publish-essay-to-github");
  expect(prefix).toContain("run_child");
  expect(prefix).toContain("Repair it THERE");
  // Nothing in the parent can change it, and the parent needs re-approving
  // once it has been changed — both have to be said, or the author edits the
  // wrong workflow and then wonders why the approval still refuses.
  expect(prefix).toContain("nothing in this workflow can change it");
  expect(prefix).toContain("review this workflow again");
  expect(calledWorkflowPrefix("run_child", null)).toContain("it starts");
});
