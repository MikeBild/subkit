import { expect, test } from "bun:test";
import { classifyBodyEnvelope, classifyBodyIteration } from "../engine/envelope.ts";

test("an empty list under a successful status code is a remote system's answer", () => {
  expect(classifyBodyEnvelope({ data: [], error: null, duration_ms: 251, status_code: 200 })).toBe(
    "productive",
  );
  expect(classifyBodyEnvelope({ data: {}, error: null, duration_ms: 9, status_code: 200 })).toBe(
    "productive",
  );
  expect(classifyBodyEnvelope({ data: null, error: null, duration_ms: 9, status_code: 204 })).toBe(
    "productive",
  );
});

test("an empty value computed in the engine keeps the warning", () => {
  expect(classifyBodyEnvelope({ data: [], error: null, duration_ms: 1 })).toBe("empty");
  expect(classifyBodyEnvelope({ data: {}, error: null, duration_ms: 1 })).toBe("empty");
  expect(classifyBodyEnvelope({ data: null, error: null, duration_ms: 1 })).toBe("empty");
});

test("a failing status is not an answer", () => {
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
  expect(classifyBodyIteration({ computed: { data: [], error: null, duration_ms: 1 } })).toEqual({
    productive: false,
    offloaded: false,
  });
  expect(classifyBodyIteration(null)).toEqual({ productive: false, offloaded: false });
});
