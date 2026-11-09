import { expect, test } from "bun:test";
import { mergeCandidateEvidence, newCandidateEvidence } from "./evidence.ts";

const existing = [
  { evidence_type: "failure", execution_id: "run-1", summary: "first" },
  { evidence_type: "failure", patch_candidate_id: "patch-1", summary: "patch" },
] as const;

test("evidence capacity rejects exhausted and negative budgets", () => {
  const incoming = [
    { evidence_type: "failure", execution_id: "run-2", summary: "next" },
    { evidence_type: "failure", execution_id: "run-3", summary: "later" },
  ];
  expect(newCandidateEvidence(existing, incoming, existing.length)).toEqual([]);
  expect(newCandidateEvidence(existing, incoming, 1)).toEqual([]);
});

test("retention caps evidence even when persisted evidence already exceeds the requested capacity", () => {
  expect(mergeCandidateEvidence(existing, [], 1)).toEqual({
    additions: [],
    retained: [existing[0]!],
  });
});

test("evidence identity keeps patch and execution references distinct and retains stable capacity order", () => {
  const incoming = [
    { evidence_type: "failure", execution_id: "run-1", summary: "rewritten" },
    { evidence_type: "failure", patch_candidate_id: "patch-2", summary: "new patch" },
    { evidence_type: "failure", execution_id: "run-3", summary: "later" },
  ];
  const merged = mergeCandidateEvidence(existing, incoming, 3);
  expect(merged.additions).toEqual([incoming[1]!]);
  expect(merged.retained).toEqual([...existing, incoming[1]!]);
  expect(existing).toEqual([
    { evidence_type: "failure", execution_id: "run-1", summary: "first" },
    { evidence_type: "failure", patch_candidate_id: "patch-1", summary: "patch" },
  ]);
});
