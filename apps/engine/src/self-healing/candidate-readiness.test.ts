import { expect, test } from "bun:test";
import { evaluatePatchReadiness, evaluatePatchSelection } from "./candidate-readiness.ts";

const input = {
  tenant_id: "tenant-a",
  candidate_id: "candidate-a",
  status: "proposed",
  version_id: "version-a",
  step_key: "read",
  dag: { steps: [{ id: "read", kind: "request", data_selector: "$.data.id" }] },
  proposal: {
    kind: "update_field_path",
    classification: "safe",
    description: "Move field",
    reasoning: "Renamed field",
    patch: { path: "/data/id", value: "data.result.id" },
  },
};

test("only a concrete executable change is reviewable", () => {
  expect(evaluatePatchReadiness(input).reviewable).toBe(true);
  expect(evaluatePatchReadiness({ ...input, step_key: null }).review_reason).toBe("no_step_anchor");
  expect(
    evaluatePatchReadiness({
      ...input,
      proposal: { ...input.proposal, patch: { properties: { id: { type: "string" } } } },
    }).review_reason,
  ).toBe("patch_not_applicable");
  expect(
    evaluatePatchReadiness({ ...input, proposal: { ...input.proposal, kind: "change_type" } })
      .reviewable,
  ).toBe(false);
  expect(evaluatePatchReadiness({ ...input, status: "applied" }).reviewable).toBe(false);
});

test("review binds tenant, candidate, exact base and proposed content", () => {
  const digest = evaluatePatchReadiness(input).review_digest;
  for (const change of [
    { tenant_id: "other" },
    { candidate_id: "other" },
    { version_id: "other" },
    { proposal: { ...input.proposal, patch: { path: "/data/id", value: "data.other.id" } } },
  ]) {
    expect(evaluatePatchReadiness({ ...input, ...change }).review_digest).not.toBe(digest);
  }
  expect(
    evaluatePatchReadiness({
      ...input,
      dag: { steps: [{ data_selector: "$.data.id", kind: "request", id: "read" }] },
    }).review_digest,
  ).toBe(digest);
});

const twoLines = {
  ...input,
  dag: {
    steps: [
      { id: "read", kind: "transform", expression: '{\n  "id": data.id,\n  "owner": data.id\n}' },
    ],
  },
};

test("the digest of a part differs from the whole and from every other part", () => {
  const whole = evaluatePatchSelection(twoLines);
  expect(whole.operations.map((operation) => operation.line)).toEqual([2, 3]);
  expect(whole.accepted).toBeNull();
  const first = evaluatePatchSelection({ ...twoLines, accepted: [0] });
  const second = evaluatePatchSelection({ ...twoLines, accepted: [1] });
  expect(first.accepted).toEqual([0]);
  expect(first.after?.expression).toBe('{\n  "id": data.result.id,\n  "owner": data.id\n}');
  expect(second.after?.expression).toBe('{\n  "id": data.id,\n  "owner": data.result.id\n}');
  const digests = [whole, first, second].map((selection) => selection.readiness.review_digest);
  expect(new Set(digests).size).toBe(3);
  expect(digests.every((digest) => /^[a-f0-9]{64}$/.test(digest ?? ""))).toBe(true);
});

test("naming every operation is the whole repair with the whole digest", () => {
  const whole = evaluatePatchSelection(twoLines);
  const named = evaluatePatchSelection({ ...twoLines, accepted: [1, 0] });
  expect(named.accepted).toBeNull();
  expect(named.readiness.review_digest).toBe(whole.readiness.review_digest);
});

test("a selection outside the operations is not reviewable", () => {
  for (const accepted of [[], [2], [0, 0]]) {
    const selection = evaluatePatchSelection({ ...twoLines, accepted });
    expect(selection.readiness).toMatchObject({
      reviewable: false,
      review_reason: "accepted_operations_invalid",
      review_digest: null,
    });
    expect(selection.after).toBeNull();
  }
});

test("a request selector is one operation, so it has no part to accept", () => {
  const whole = evaluatePatchSelection(input);
  expect(whole.operations.map((operation) => [operation.path, operation.line])).toEqual([
    ["data_selector", null],
  ]);
  expect(evaluatePatchSelection({ ...input, accepted: [0] }).readiness.review_digest).toBe(
    whole.readiness.review_digest,
  );
});

test("a gate repair is accepted whole or not at all", () => {
  const boundary = {
    kind: "gmail_report",
    to: "a@example.test",
    from: "b@example.test",
    content_type: "text/html",
  };
  const declared = { ...boundary, to: "c@example.test", from: "d@example.test" };
  const gate = {
    ...input,
    step_key: "send",
    drift_kind: "gate_block",
    dag: { steps: [{ id: "send", kind: "request", method: "POST", report_delivery: boundary }] },
    proposal: {
      kind: "gate_fix",
      classification: "unsafe",
      description: "Declare the delivery",
      reasoning: "The gate observed another recipient",
      patch: {
        fixer: "declare_report_delivery",
        step_id: "send",
        subject_step_id: "send",
        ops: [{ op: "replace", path: "/report_delivery", value: declared }],
      },
    },
  };
  const whole = evaluatePatchSelection(gate);
  expect(whole.readiness.reviewable).toBe(true);
  expect(whole.operations.map((operation) => operation.path)).toEqual([
    "report_delivery.from",
    "report_delivery.to",
  ]);
  expect(evaluatePatchSelection({ ...gate, accepted: [0] }).readiness.review_reason).toBe(
    "partial_gate_fix",
  );
  expect(evaluatePatchSelection({ ...gate, accepted: [0, 1] }).readiness.review_digest).toBe(
    whole.readiness.review_digest,
  );
});
