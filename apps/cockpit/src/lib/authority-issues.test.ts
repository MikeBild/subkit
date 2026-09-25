// A reviewer who cannot see the reason cannot judge the approval.
//
// The review surface said "Grenzen geändert" and stopped there — four words
// for a state that names a step, a code, and for a contradicted folder the key
// the step really wrote. Two wrong folders reached production and stayed
// invisible for exactly as long as that sentence was all anyone could read.

import { expect, test } from "bun:test";
import { authorityIssues } from "./authority-issues";

type Preview = Parameters<typeof authorityIssues>[0];

const preview = (over: Record<string, unknown>) =>
  ({
    manifest: { issues: [], effects: [] },
    unavailable_steps: [],
    ...over,
  }) as unknown as Preview;

test("every issue becomes a sentence tied to its step", () => {
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "store_manifest", code: "boundary_contradicted_by_history" },
          { step_id: "send", code: "dynamic_request" },
        ],
      },
    }),
  );
  expect(issues.map((i) => [i.step_id, i.messageKey])).toEqual([
    ["store_manifest", "authority.issue.boundary_contradicted_by_history"],
    ["send", "authority.issue.dynamic_request"],
  ]);
  expect(issues.every((i) => i.call_step_id === null)).toBe(true);
});

test("a contradicted folder carries the two values that make it actionable", () => {
  // Without these the reviewer is told that something is wrong and not what:
  // the declared folder and the key the step actually wrote are the whole fix.
  const [issue] = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [{ step_id: "store_manifest", code: "boundary_contradicted_by_history" }],
      },
      boundary_contradictions: [
        {
          step_id: "store_manifest",
          declared_prefix: "v1/latest/",
          observed_key: "v1/infrastructure/manifests/year=2026/month=09/day=10/e9d904a6.json",
          observed_at: "2026-09-10T07:55:00.000Z",
        },
      ],
    }),
  );
  expect(issue?.evidence).toEqual({
    declared_prefix: "v1/latest/",
    observed_key: "v1/infrastructure/manifests/year=2026/month=09/day=10/e9d904a6.json",
  });
});

test("evidence is attached only to the issue it explains", () => {
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "store_manifest", code: "dynamic_request" },
          { step_id: "other", code: "boundary_contradicted_by_history" },
        ],
      },
      // Same step id as the FIRST issue, but that issue is a different code.
      boundary_contradictions: [
        {
          step_id: "store_manifest",
          declared_prefix: "v1/latest/",
          observed_key: "v1/elsewhere/a.json",
          observed_at: "2026-09-10T07:55:00.000Z",
        },
      ],
    }),
  );
  expect(issues[0]?.evidence).toBeUndefined();
  // And an issue whose evidence the engine did not supply still renders.
  expect(issues[1]?.evidence).toBeUndefined();
  expect(issues[1]?.messageKey).toBe("authority.issue.boundary_contradicted_by_history");
});

test("an issue inside a called workflow says which step started it", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [{ step_id: "publish", code: "dynamic_request", call_path: ["run_child"] }],
      },
    }),
  );
  expect(issue?.call_step_id).toBe("run_child");
});

test("a parent and a child sharing a step id and code stay two reasons", () => {
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "publish", code: "dynamic_request" },
          { step_id: "publish", code: "dynamic_request", call_path: ["run_child"] },
        ],
      },
    }),
  );
  expect(issues).toHaveLength(2);
  expect(issues[0]?.key).not.toBe(issues[1]?.key);
});

test("nothing to report is an empty list, never a placeholder", () => {
  expect(authorityIssues(preview({}))).toEqual([]);
  expect(authorityIssues(null)).toEqual([]);
});

test("the engine's own reason replaces the blanket code", () => {
  // The production case. `send_reminder` posts to a CONSTANT address, and the
  // dialog told the reader "where this request goes is decided at runtime and
  // is bounded by nothing checkable". The engine's refusal for that same step
  // was `stricter_profile_applies` — a different statement about a different
  // kind of problem, reported beside the manifest and never shown.
  const [issue] = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [{ step_id: "send_reminder", code: "dynamic_request" }],
      },
      request_refusals: [{ step_id: "send_reminder", reason: "stricter_profile_applies" }],
    }),
  );
  expect(issue?.reasonKey).toBe("authority.refusal.stricter_profile_applies");
  // The blanket code stays available for grouping and for the fallback, but it
  // is not what the reader is shown.
  expect(issue?.code).toBe("dynamic_request");
});

test("a storage refusal is read from its own list", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: { effects: [], issues: [{ step_id: "store_report", code: "dynamic_request" }] },
      storage_refusals: [{ step_id: "store_report", reason: "no_scope" }],
    }),
  );
  expect(issue?.reasonKey).toBe("authority.refusal.no_scope");
});

test("a refusal for a different step is not borrowed", () => {
  // A parent and a called child may use the same step id, and a refusal that
  // belongs to one is not evidence about the other.
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "fetch", code: "dynamic_request" },
          { step_id: "fetch", code: "dynamic_request", call_path: ["call_child"] },
        ],
      },
      request_refusals: [
        { step_id: "fetch", reason: "no_boundary" },
        { step_id: "fetch", reason: "connector_adds_query", call_path: ["call_child"] },
      ],
    }),
  );
  expect(issues.map((i) => i.reasonKey)).toEqual([
    "authority.refusal.no_boundary",
    "authority.refusal.connector_adds_query",
  ]);
});

test("a reason we have no sentence for falls back rather than printing an identifier", () => {
  // The engine's vocabulary can grow without this surface. Showing the raw
  // code at somebody is worse than the general sentence.
  const [issue] = authorityIssues(
    preview({
      manifest: { effects: [], issues: [{ step_id: "a", code: "dynamic_request" }] },
      request_refusals: [{ step_id: "a", reason: "some_future_code" }],
    }),
  );
  expect(issue?.reasonKey).toBeUndefined();
  expect(issue?.messageKey).toBe("authority.issue.dynamic_request");
});
