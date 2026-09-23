// An empty answer from a system that answered is a result, not a defect.
//
// The empty-loop heuristic exists to catch a real bug: a loop body that reads
// the wrong scope, computes nothing for every iteration, and reports
// "succeeded" with no rows. It judged that by the SHAPE of the payload, so it
// could not tell that bug apart from a remote system truthfully saying
// "nothing". A weekly growth workflow asked GitHub for three repositories'
// traffic referrers, got `200` with `[]` three times because those
// repositories genuinely had no referrals in the window, and the preview came
// back "needs repair — fix the flagged step before committing". No edit to
// that step could ever make it green: the repair asked for the impossible, and
// the correct draft could not be committed, so its approval dialog kept
// offering the old version. These pin the distinction.

import { expect, test } from "bun:test";
import { classifyBodyEnvelope, classifyBodyIteration } from "../engine/envelope.ts";

test("an empty list under a successful status code is a remote system's answer", () => {
  expect(classifyBodyEnvelope({ data: [], error: null, duration_ms: 251, status_code: 200 })).toBe(
    "productive",
  );
  // Same for an empty object and for a body-less success.
  expect(classifyBodyEnvelope({ data: {}, error: null, duration_ms: 9, status_code: 200 })).toBe(
    "productive",
  );
  expect(classifyBodyEnvelope({ data: null, error: null, duration_ms: 9, status_code: 204 })).toBe(
    "productive",
  );
});

test("an empty value computed in the engine keeps the warning", () => {
  // A transform envelope never carries a status_code — nothing outside the
  // engine was asked, so `[]` is the original defect this heuristic catches.
  expect(classifyBodyEnvelope({ data: [], error: null, duration_ms: 1 })).toBe("empty");
  expect(classifyBodyEnvelope({ data: {}, error: null, duration_ms: 1 })).toBe("empty");
  expect(classifyBodyEnvelope({ data: null, error: null, duration_ms: 1 })).toBe("empty");
});

test("a failing status is not an answer", () => {
  // 4xx/5xx normally set `error` too, but the status alone must not launder a
  // failed call into "productive".
  expect(classifyBodyEnvelope({ data: [], error: null, duration_ms: 3, status_code: 404 })).toBe(
    "empty",
  );
  expect(
    classifyBodyEnvelope({
      data: null,
      error: { code: "http_error", message: "boom" },
      duration_ms: 3,
      status_code: 500,
    }),
  ).toBe("empty");
});

test("held writes and their skipped dependents stay productive", () => {
  expect(classifyBodyEnvelope({ data: null, error: null, duration_ms: 0, held: true })).toBe(
    "productive",
  );
  expect(
    classifyBodyEnvelope({
      data: null,
      error: { code: "skipped_dependency_held", message: "skipped" },
      duration_ms: 0,
    }),
  ).toBe("productive");
});

test("an offloaded payload is reported separately so the metric still counts it", () => {
  const ref = {
    $offloaded: true,
    storage_uri: "s3://bucket/v1/offload/abc",
    preview: "[…]",
    size_bytes: 9_000_000,
  };
  expect(classifyBodyEnvelope({ data: ref, error: null, duration_ms: 12 })).toBe("offloaded");
  expect(classifyBodyIteration({ big: { data: ref, error: null, duration_ms: 12 } })).toEqual({
    productive: true,
    offloaded: true,
  });
});

test("one productive envelope makes the whole iteration productive", () => {
  const iteration = {
    referrers: { data: [], error: null, duration_ms: 251, status_code: 200 },
    computed: { data: [], error: null, duration_ms: 1 },
  };
  expect(classifyBodyIteration(iteration)).toEqual({ productive: true, offloaded: false });
  // …and an iteration of only in-engine empties is still empty.
  expect(classifyBodyIteration({ computed: { data: [], error: null, duration_ms: 1 } })).toEqual({
    productive: false,
    offloaded: false,
  });
  expect(classifyBodyIteration(null)).toEqual({ productive: false, offloaded: false });
});
