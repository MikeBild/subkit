import { expect, test } from "bun:test";
import { evaluatePatchReadiness } from "./candidate-readiness.ts";

const input = {
  tenant_id: "tenant-a",
  candidate_id: "candidate-a",
  status: "proposed",
  version_id: "version-a",
  step_key: "read",
  dag: { steps: [{ id: "read", kind: "request", data_selector: "data.id" }] },
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
      dag: { steps: [{ data_selector: "data.id", kind: "request", id: "read" }] },
    }).review_digest,
  ).toBe(digest);
});
