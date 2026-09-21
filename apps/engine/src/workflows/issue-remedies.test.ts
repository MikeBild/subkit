// An issue code without a remedy is a diagnosis the reader has to guess at.
//
// These pin the mapping that closed a real failure: asked to bound a retention
// workflow's removals, the authoring model diagnosed `dynamic_request` on two
// s3 steps correctly, received an empty guidance list, and invented a remedy
// out of `s3.max_keys` — a field that exists but is derived from the step, not
// authored. The remedy now travels with the diagnosis, and it names that trap
// by name.

import { expect, test } from "bun:test";
import { remedyFor, repairGuidanceForIssues } from "./issue-remedies.ts";

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
  expect(remedyFor("dynamic_request", "http")).toBeNull();
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
