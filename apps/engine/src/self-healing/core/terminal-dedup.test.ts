import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  candidateDriftFingerprint,
  candidateProposal,
  inapplicableBoundaryMatches,
  matchesCandidateBoundary,
  signalFingerprint,
} from "./terminal-dedup.ts";

const signal = { kind: "validation_failed" as const, expression: "true", actual_value: 0 };

test("candidate projection preserves a saved proposal and supplies the terminal fallback", () => {
  expect(candidateDriftFingerprint({ diff: null })).toBeNull();
  expect(candidateDriftFingerprint({ diff: {} })).toBeNull();
  expect(candidateDriftFingerprint({ diff: { drift_signal: signal } })).toBe(
    signalFingerprint(signal),
  );
  const proposal = {
    classification: "safe",
    kind: "rename_param",
    description: "saved",
    patch: {},
    reasoning: "saved",
  };
  expect(candidateProposal({ classification: "unsafe", diff: { proposal } })).toBe(proposal);
  expect(candidateProposal({ classification: "unsafe", diff: null })).toEqual({
    classification: "unsafe",
    kind: "other",
    description: "terminal candidate skipped without re-running repair",
    patch: {},
    reasoning: "A terminal candidate already covers the same proactive drift fingerprint.",
  });
});

test("version and step boundaries admit legacy missing facts but never a different known boundary", () => {
  const candidate = {
    status: "proposed",
    diff: { base_version_id: "v1", workflow_step_id: "s1", applied_version_id: "v2" },
  };
  expect(matchesCandidateBoundary(candidate, {})).toBe(true);
  expect(
    matchesCandidateBoundary(candidate, { base_version_id: "v1", workflow_step_id: "s1" }),
  ).toBe(true);
  expect(matchesCandidateBoundary(candidate, { base_version_id: "v2" })).toBe(false);
  expect(
    matchesCandidateBoundary({ ...candidate, status: "applied" }, { base_version_id: "v2" }),
  ).toBe(true);
  expect(matchesCandidateBoundary(candidate, { workflow_step_id: "s2" })).toBe(false);
  expect(
    matchesCandidateBoundary(
      { status: "proposed", diff: {} },
      { base_version_id: "v2", workflow_step_id: "s2" },
    ),
  ).toBe(true);
});

test("inapplicable candidates stop matching after a missing step anchor becomes available", () => {
  const candidate = {
    diff: { drift_signal: signal, workflow_step_id: "step" },
    closed_against_version_id: "version",
  };
  const params = {
    connector_id: "connector",
    endpoint_key: "endpoint",
    base_version_id: "version",
    workflow_step_id: "step",
  };
  const fingerprint = signalFingerprint(signal);
  expect(inapplicableBoundaryMatches(candidate, params, fingerprint, false)).toBe(true);
  expect(inapplicableBoundaryMatches(candidate, params, fingerprint, true)).toBe(false);
  expect(
    inapplicableBoundaryMatches(
      candidate,
      { ...params, base_version_id: "other" },
      fingerprint,
      false,
    ),
  ).toBe(false);
  expect(
    inapplicableBoundaryMatches(
      candidate,
      { ...params, workflow_step_id: "other" },
      fingerprint,
      false,
    ),
  ).toBe(false);
  expect(inapplicableBoundaryMatches(candidate, params, "other", false)).toBe(false);
  expect(
    inapplicableBoundaryMatches(
      { ...candidate, closed_against_version_id: null },
      params,
      fingerprint,
      false,
    ),
  ).toBe(false);
  expect(inapplicableBoundaryMatches({ ...candidate, diff: {} }, params, "other", false)).toBe(
    true,
  );
  expect(
    inapplicableBoundaryMatches(
      { ...candidate, diff: {} },
      { ...params, connector_id: null },
      "other",
      false,
    ),
  ).toBe(false);
  expect(
    inapplicableBoundaryMatches(
      { ...candidate, diff: {} },
      { ...params, endpoint_key: null },
      "other",
      false,
    ),
  ).toBe(false);
});

test("fingerprints preserve significant gate/stdlib facts and normalize schema set order", () => {
  const gate = {
    kind: "gate_block" as const,
    code: "gate",
    reason: null,
    fixer: "use_utf8_encoder" as const,
    step_id: "send",
  };
  expect(signalFingerprint(gate)).not.toBe(signalFingerprint({ ...gate, step_id: "other" }));
  const stdlib = {
    kind: "stdlib_version_drift" as const,
    surface: "workflow" as const,
    resource_id: "w",
    recorded_version: "1",
    current_version: "2",
    recorded_major: 1,
    current_major: 2,
  };
  expect(signalFingerprint(stdlib)).not.toBe(signalFingerprint({ ...stdlib, current_major: 3 }));
  const shape = {
    kind: "schema_diff" as const,
    before: { type: "string" as const },
    after: { type: "string" as const },
    added: ["a", "b"],
    removed: ["d", "c"],
    widened: ["y", "x"],
  };
  const before = JSON.stringify(shape);
  expect(signalFingerprint(shape)).toBe(
    signalFingerprint({ ...shape, added: ["b", "a"], removed: ["c", "d"], widened: ["x", "y"] }),
  );
  expect(JSON.stringify(shape)).toBe(before);
});

test("request identity preserves explicit paths and handles missing or non-URL locations", () => {
  const endpoint = {
    kind: "endpoint_contract" as const,
    severity: "removed" as const,
    request: {},
    sunset: null,
    successor_uri: null,
  };
  expect(signalFingerprint(endpoint)).toContain('"origin":null,"path":null');
  expect(signalFingerprint({ ...endpoint, request: { url: "not-a-url?x=1" } })).toContain(
    '"path":"not-a-url"',
  );
  expect(
    signalFingerprint({
      ...endpoint,
      request: { url: "https://example.org/ignored", path: "/chosen#fragment", method: "get" },
    }),
  ).toContain('"method":"GET","origin":"https://example.org","path":"/chosen"');
});

test("irrelevant observation values never change an invariant fingerprint", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (actual_value) => {
      expect(signalFingerprint({ ...signal, actual_value })).toBe(signalFingerprint(signal));
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("schema fingerprints encode ordered keys and distinct canonical change arrays", () => {
  const shape = {
    kind: "schema_diff" as const,
    before: { type: "string" as const },
    after: { type: "number" as const },
    added: ["b", "a"],
    removed: ["d", "c"],
    widened: ["f", "e"],
  };
  expect(signalFingerprint(shape)).toBe(
    '{"added":["a","b"],"after":{"type":"number"},"before":{"type":"string"},"kind":"schema_diff","removed":["c","d"],"widened":["e","f"]}',
  );
  expect(signalFingerprint({ ...shape, added: [] })).not.toBe(signalFingerprint(shape));
  expect(signalFingerprint({ ...shape, removed: [] })).not.toBe(signalFingerprint(shape));
  expect(signalFingerprint({ ...shape, widened: [] })).not.toBe(signalFingerprint(shape));
});

test("an applied candidate still cannot claim an unrelated version", () => {
  expect(
    matchesCandidateBoundary(
      {
        status: "applied",
        diff: { base_version_id: "before", applied_version_id: "after" },
      },
      { base_version_id: "unrelated" },
    ),
  ).toBe(false);
});

test("nested schema field insertion order does not change a drift fingerprint", () => {
  const first = {
    kind: "http_status_new_shape" as const,
    status: 200,
    request: { url: "https://example.org/items" },
    response_before: null,
    response_after: {
      type: "object" as const,
      properties: { z: { type: "number" as const }, a: { type: "string" as const } },
    },
  };
  const second = {
    ...first,
    response_after: {
      type: "object" as const,
      properties: { a: { type: "string" as const }, z: { type: "number" as const } },
    },
  };
  expect(signalFingerprint(first)).toBe(signalFingerprint(second));
});

test("gate fingerprints exclude observation metadata outside the repair boundary", () => {
  const gate = {
    kind: "gate_block" as const,
    code: "gate",
    reason: null,
    fixer: "use_utf8_encoder" as const,
    step_id: "send",
  };
  const observed = { ...gate, observed_at: "2026-11-09T00:00:00Z" };
  expect(signalFingerprint(observed)).toBe(signalFingerprint(gate));
});

test("an empty request URL carries no location in a terminal fingerprint", () => {
  const endpoint = {
    kind: "endpoint_contract" as const,
    severity: "removed" as const,
    request: { url: "" },
    sunset: null,
    successor_uri: null,
  };
  expect(signalFingerprint(endpoint)).toBe(signalFingerprint({ ...endpoint, request: {} }));
});
