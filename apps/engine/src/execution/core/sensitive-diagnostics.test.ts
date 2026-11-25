import { describe, expect, test } from "bun:test";
import {
  bodyByteLength,
  bodySizeBucket,
  failureStatusClass,
  isBodySizeBucket,
  placeholderTypes,
  recordedPlaceholderTypes,
  statusClass,
} from "./sensitive-diagnostics.ts";

describe("statusClass keeps only the class of an upstream answer", () => {
  test.each([
    [200, "2xx"],
    [204, "2xx"],
    [301, "3xx"],
    [400, "4xx"],
    [401, "4xx"],
    [409, "4xx"],
    [429, "4xx"],
    [500, "5xx"],
    [503, "5xx"],
    [599, "5xx"],
    [100, null],
    [600, null],
    [Number.NaN, null],
    [404.5, null],
  ] as const)("status %p reads as %p", (status, expected) => {
    expect(statusClass(status)).toBe(expected);
  });

  test.each([
    ["http_4xx", "4xx"],
    ["http_429", "4xx"],
    ["upstream_rate_limited", "4xx"],
    ["http_5xx", "5xx"],
    ["graphql_5xx", "5xx"],
    ["connection", "network"],
    ["timeout", "timeout"],
    ["step_timeout", "timeout"],
    ["2xx", "2xx"],
    ["network", "network"],
    ["unexpected_status_code", null],
    ["driver_exploded", null],
    ["", null],
  ] as const)("error code %p reads as %p", (code, expected) => {
    expect(statusClass(code)).toBe(expected);
  });

  test("nothing to read yields no class", () => {
    expect(statusClass(null)).toBeNull();
    expect(statusClass(undefined)).toBeNull();
  });
});

describe("bodySizeBucket keeps only a coarse size", () => {
  test.each([
    [0, "<1KB"],
    [1023, "<1KB"],
    [1024, "<10KB"],
    [10 * 1024 - 1, "<10KB"],
    [10 * 1024, "<100KB"],
    [100 * 1024, "<1MB"],
    [1024 * 1024 - 1, "<1MB"],
    [1024 * 1024, ">=1MB"],
    [50 * 1024 * 1024, ">=1MB"],
    [-1, null],
    [Number.NaN, null],
    [null, null],
    [undefined, null],
  ] as const)("%p bytes fall into %p", (bytes, expected) => {
    expect(bodySizeBucket(bytes)).toBe(expected);
  });
});

describe("bodyByteLength measures what would be sent", () => {
  test.each([
    [null, null],
    [undefined, null],
    ["abc", 3],
    ["€", 3],
    [{ a: 1 }, 7],
    [[1, 2], 5],
    [42, 2],
  ] as const)("%p measures %p bytes", (body, expected) => {
    expect(bodyByteLength(body)).toBe(expected);
  });
});

describe("placeholderTypes names placeholders and their JSON types, never values", () => {
  test("whole-value placeholders keep the type of what they resolved to", () => {
    const template = {
      app: {
        argv: "${input.body.app.argv}",
        name: "${input.name}",
        count: "${input.count}",
        on: "${input.flag}",
        meta: "${input.meta}",
        gone: "${input.gone}",
      },
      list: ["${item.id}"],
      fixed: 3,
    };
    const resolved = {
      app: {
        argv: ["--token", "SECRET"],
        name: "Jane",
        count: 7,
        on: false,
        meta: { private: "PRIVATE" },
        gone: null,
      },
      list: [99],
      fixed: 3,
    };
    const types = placeholderTypes(template, resolved);
    expect(types).toEqual({
      "input.body.app.argv": "array",
      "input.name": "string",
      "input.count": "number",
      "input.flag": "boolean",
      "input.meta": "object",
      "input.gone": "null",
      "item.id": "number",
    });
    expect(JSON.stringify(types)).not.toContain("SECRET");
    expect(JSON.stringify(types)).not.toContain("PRIVATE");
    expect(JSON.stringify(types)).not.toContain("Jane");
  });

  test("a placeholder inside text is a string and an unchanged one is unresolved", () => {
    expect(
      placeholderTypes(
        { greeting: "Hello ${input.name}!", missing: "${input.missing}" },
        { greeting: "Hello Jane!", missing: "${input.missing}" },
      ),
    ).toEqual({ "input.name": "string", "input.missing": "unresolved" });
  });

  test("a placeholder whose resolved slot is absent reads as unresolved", () => {
    expect(placeholderTypes({ a: "${input.a}" }, {})).toEqual({ "input.a": "unresolved" });
    expect(placeholderTypes(["${input.a}"], "flat")).toEqual({ "input.a": "unresolved" });
    expect(placeholderTypes({ a: "${input.a}" }, { a: 10n })).toEqual({ "input.a": "unresolved" });
  });

  test("credential and secret placeholders are never listed", () => {
    expect(
      placeholderTypes(
        { auth: "${cred.crm.token}", key: "${secret.api_key}", id: "${input.id}" },
        { auth: "t", key: "k", id: "1" },
      ),
    ).toEqual({ "input.id": "string" });
  });

  test("malformed placeholders and plain values list nothing", () => {
    expect(placeholderTypes({ a: "${input.a", b: "plain", c: 1 }, { a: "x" })).toEqual({});
    expect(placeholderTypes({ a: "$${input.a}" }, { a: "${input.a}" })).toEqual({});
    expect(placeholderTypes(null, null)).toEqual({});
    expect(placeholderTypes(undefined, undefined)).toEqual({});
  });

  test("the list stays bounded", () => {
    const template = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`k${index}`, `\${input.f${index}}`]),
    );
    const resolved = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`k${index}`, index]),
    );
    expect(Object.keys(placeholderTypes(template, resolved))).toHaveLength(32);
  });
});

describe("failureStatusClass reads the class of a stored step failure", () => {
  test.each([
    [{ code: "sensitive_execution_failure", status_class: "5xx" }, undefined, "5xx"],
    [{ code: "http_4xx", upstream_status: 503 }, undefined, "5xx"],
    [{ code: "unexpected_status_code" }, 409, "4xx"],
    [{ code: "connection" }, undefined, "network"],
    [{ code: "step_timeout", status_class: "made_up" }, undefined, "timeout"],
    [{ code: "driver_exploded", upstream_status: "500" }, "500", null],
    [{ code: 7 }, undefined, null],
    [null, 500, null],
    ["http_5xx", undefined, null],
  ] as const)("%p with status %p reads as %p", (error, status, expected) => {
    expect(failureStatusClass(error, status)).toBe(expected);
  });
});

describe("recorded diagnostics are re-read strictly", () => {
  test("only known placeholder types under plain path names survive", () => {
    expect(
      recordedPlaceholderTypes({
        "input.body.app.argv": "array",
        "item[0].id": "number",
        "input.x": "SECRET",
        "bad name with spaces": "string",
        "": "string",
      }),
    ).toEqual({ "input.body.app.argv": "array", "item[0].id": "number" });
  });

  test("anything but a non-empty record reads as nothing", () => {
    expect(recordedPlaceholderTypes(null)).toBeNull();
    expect(recordedPlaceholderTypes(["array"])).toBeNull();
    expect(recordedPlaceholderTypes("array")).toBeNull();
    expect(recordedPlaceholderTypes({ "input.x": "SECRET" })).toBeNull();
  });

  test("a recorded body size is one of the buckets", () => {
    expect(isBodySizeBucket("<10KB")).toBe(true);
    expect(isBodySizeBucket("1234")).toBe(false);
    expect(isBodySizeBucket(undefined)).toBe(false);
  });
});
