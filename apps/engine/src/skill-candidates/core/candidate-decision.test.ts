import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  decideExistingCandidate,
  decideSignalUpsert,
  initialCandidateStatus,
} from "./candidate-decision.ts";
import {
  evidenceIdentity,
  mergeCandidateEvidence,
  newCandidateEvidence,
  uniqueEvidence,
} from "./evidence.ts";

const evidence = (summary: string, execution_id: string | null = null) => ({
  evidence_type: "success",
  summary,
  execution_id,
});

test("learning signals are context while other signals need a proposal review", () => {
  expect(initialCandidateStatus("failure_pattern")).toBe("context");
  expect(initialCandidateStatus("authoring_capability")).toBe("context");
  expect(initialCandidateStatus("success_pattern")).toBe("proposed");
  expect(initialCandidateStatus("")).toBe("proposed");
});

test("terminal decisions are never overwritten by a newly observed signal", () => {
  for (const status of ["rejected", "superseded", "approved"] as const)
    expect(decideExistingCandidate(Object.freeze({ status, version: 3 }))).toEqual({
      kind: "skip",
      reason: status,
    });
  for (const status of ["proposed", "context"])
    expect(decideExistingCandidate(Object.freeze({ status, version: 3 }))).toEqual({
      kind: "update",
      version: 4,
    });
});

test("signal upsert selects insertion, terminal skip, refresh, and endpoint-less supersession", () => {
  expect(decideSignalUpsert(null, { pattern_kind: "success_pattern", endpoint_key: null })).toEqual(
    {
      kind: "insert",
      initial_status: "proposed",
      supersede_open: true,
    },
  );
  expect(
    decideSignalUpsert(null, { pattern_kind: "failure_pattern", endpoint_key: "get:/x" }),
  ).toEqual({
    kind: "insert",
    initial_status: "context",
    supersede_open: false,
  });
  expect(decideSignalUpsert({ status: "approved", version: 1 }, { pattern_kind: "x" })).toEqual({
    kind: "skip",
    reason: "approved",
  });
  expect(decideSignalUpsert({ status: "proposed", version: 1 }, { pattern_kind: "x" })).toEqual({
    kind: "update",
    version: 2,
  });
});

test("evidence identity prefers stable execution/patch references over changing prose", () => {
  expect(evidenceIdentity(evidence("one", "run"))).toBe(evidenceIdentity(evidence("two", "run")));
  expect(evidenceIdentity({ ...evidence("one"), patch_candidate_id: "patch" })).toBe(
    evidenceIdentity({ ...evidence("two"), patch_candidate_id: "patch" }),
  );
  expect(evidenceIdentity(evidence("one"))).not.toBe(evidenceIdentity(evidence("two")));
  expect(evidenceIdentity(evidence("one", "run"))).not.toBe(
    evidenceIdentity({ ...evidence("one", "run"), evidence_type: "failure" }),
  );
  expect(evidenceIdentity(evidence("one"))).toBe('["success",null,null,"one"]');
});

test("merging keeps the newest payload at stable first position and respects persisted capacity", () => {
  const first = evidence("old", "a");
  const second = evidence("second", "b");
  const replacement = evidence("new", "a");
  expect(uniqueEvidence([first, second, replacement])).toEqual([replacement, second]);
  expect(newCandidateEvidence([first], [replacement, second, evidence("third", "c")], 2)).toEqual([
    second,
  ]);
  expect(newCandidateEvidence([first], [second], 1)).toEqual([]);
  expect(newCandidateEvidence([first, first], [second], 1)).toEqual([]);
  expect(newCandidateEvidence([], [first, second], 0)).toEqual([]);
  expect(newCandidateEvidence([], [], 50)).toEqual([]);
});

test("merge projection returns additions and an immutable capped retained view", () => {
  const existing = Object.freeze([Object.freeze(evidence("old", "a"))]);
  const incoming = Object.freeze([
    Object.freeze(evidence("same", "a")),
    Object.freeze(evidence("next", "b")),
  ]);
  const before = JSON.stringify({ existing, incoming });
  expect(mergeCandidateEvidence(existing, incoming, 2)).toEqual({
    additions: [evidence("next", "b")],
    retained: [evidence("old", "a"), evidence("next", "b")],
  });
  expect(JSON.stringify({ existing, incoming })).toBe(before);
});

test("evidence admission is bounded, idempotent and does not mutate facts", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string(), { maxLength: 30 }),
      fc.integer({ min: 0, max: 20 }),
      (summaries, capacity) => {
        const incoming = Object.freeze(
          summaries.map((summary) => Object.freeze(evidence(summary))),
        );
        const before = JSON.stringify(incoming);
        const admitted = newCandidateEvidence([], incoming, capacity);
        expect(admitted.length).toBeLessThanOrEqual(capacity);
        expect(new Set(admitted.map(evidenceIdentity)).size).toBe(admitted.length);
        expect(newCandidateEvidence(admitted, admitted, capacity)).toEqual([]);
        expect(JSON.stringify(incoming)).toBe(before);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
