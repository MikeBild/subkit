import { expect, test } from "bun:test";

import { signalFingerprint } from "./terminal-dedup.ts";

test("new observations of the same missing path do not create new decisions", () => {
  const signal = {
    kind: "jsonata_path_miss" as const,
    expression: "data.id",
    missing_path: "data.id",
    prior_value: 1,
  };
  expect(signalFingerprint(signal)).toBe(signalFingerprint({ ...signal, prior_value: 2 }));
  expect(signalFingerprint(signal)).not.toBe(
    signalFingerprint({ ...signal, missing_path: "data.other" }),
  );
});

test("changed failed validation output is evidence of the same invariant", () => {
  const signal = {
    kind: "validation_failed" as const,
    expression: "$count(items) > 0",
    actual_value: [],
  };
  expect(signalFingerprint(signal)).toBe(signalFingerprint({ ...signal, actual_value: {} }));
  expect(signalFingerprint(signal)).not.toBe(
    signalFingerprint({ ...signal, expression: "$count(items) > 1" }),
  );
});

test("request observations ignore query values but preserve the endpoint and host", () => {
  const signal = {
    kind: "http_status_new_shape" as const,
    status: 404,
    request: { method: "GET", url: "https://api.example.test/items?day=1" },
    response_before: null,
    response_after: { type: "string" as const },
  };
  expect(signalFingerprint(signal)).toBe(
    signalFingerprint({
      ...signal,
      request: { ...signal.request, url: "https://api.example.test/items?day=2" },
    }),
  );
  expect(signalFingerprint(signal)).not.toBe(
    signalFingerprint({
      ...signal,
      request: { ...signal.request, url: "https://other.example.test/items?day=1" },
    }),
  );
  expect(signalFingerprint(signal)).not.toBe(
    signalFingerprint({
      ...signal,
      request: { ...signal.request, url: "https://api.example.test/orders?day=1" },
    }),
  );
});
