import { describe, expect, test } from "bun:test";
import {
  engineErrorDetailLines,
  exitCodeFor,
  formatError,
  isEngineError,
  isTransportError,
} from "./errors-classification.ts";

function engine(status: number, trace: string | null = null) {
  return Object.assign(new Error("Denied"), {
    name: "EngineError",
    status,
    code: "access_denied",
    trace_id: trace,
  });
}

describe("error classification", () => {
  test("requires Error identity as well as the engine name and numeric status", () => {
    expect(isEngineError(engine(403))).toBe(true);
    for (const value of [
      null,
      undefined,
      "error",
      403,
      {},
      { name: "EngineError", status: 403 },
      new Error("bad"),
      Object.assign(new Error(), { name: "EngineError", status: "403" }),
    ])
      expect(isEngineError(value)).toBe(false);
    expect(isEngineError(Object.assign(new Error(), { name: "OtherError", status: 403 }))).toBe(
      false,
    );
  });

  test("requires Error identity for transport failures", () => {
    expect(isTransportError(Object.assign(new Error("offline"), { name: "TransportError" }))).toBe(
      true,
    );
    for (const value of [
      null,
      undefined,
      "offline",
      { name: "TransportError" },
      new Error("offline"),
    ])
      expect(isTransportError(value)).toBe(false);
  });

  test("formats engine traces and preserves ordinary or transport error messages", () => {
    expect(formatError(engine(403))).toBe("access_denied: Denied");
    expect(formatError(engine(403, "trace-1"))).toBe("access_denied: Denied [trace=trace-1]");
    expect(formatError(engine(403, ""))).toBe("access_denied: Denied");
    expect(formatError(Object.assign(new Error("offline"), { name: "TransportError" }))).toBe(
      "offline",
    );
    expect(formatError(new Error("unknown"))).toBe("unknown");
    expect(formatError("bad input")).toBe("bad input");
    expect(formatError(null)).toBe("null");
    expect(formatError(undefined)).toBe("undefined");
    expect(formatError(42)).toBe("42");
  });

  test("distinguishes rejected commands from service or transport failures", () => {
    for (const status of [400, 409, 422]) expect(exitCodeFor(engine(status))).toBe(1);
    for (const status of [0, 399, 401, 408, 410, 421, 423, 500])
      expect(exitCodeFor(engine(status))).toBe(2);
    expect(exitCodeFor(Object.assign(new Error("offline"), { name: "TransportError" }))).toBe(2);
    expect(exitCodeFor(new Error("bad"))).toBe(1);
    expect(exitCodeFor("bad")).toBe(1);
  });
});

describe("validation error details", () => {
  test("ignores missing or unrecognized detail collections", () => {
    const callableDetails = Object.assign(() => undefined, { formErrors: ["must be ignored"] });
    const callableFieldErrors = Object.assign(() => undefined, { field: ["must be ignored"] });
    const callableIssue = Object.assign(() => undefined, {
      path: "callable",
      message: "must be ignored",
    });
    for (const value of [
      null,
      undefined,
      false,
      0,
      "bad",
      {},
      [],
      { formErrors: "bad", fieldErrors: "bad", issues: "bad" },
      callableDetails,
      { fieldErrors: callableFieldErrors },
      { issues: [callableIssue] },
    ])
      expect(engineErrorDetailLines(value)).toEqual([]);
  });

  test("retains form and field messages in order without mutating the input", () => {
    const input = Object.freeze({
      formErrors: Object.freeze(["first", "", null, 2, "second"]),
      fieldErrors: Object.freeze({
        name: Object.freeze(["Required", 1, ""]),
        unused: "ignored",
        other: Object.freeze(["Invalid"]),
      }),
    });
    expect(engineErrorDetailLines(input)).toEqual([
      "first",
      "second",
      "name: Required",
      "name: ",
      "other: Invalid",
    ]);
  });

  test("renders indexed and scalar issue paths and skips invalid issues", () => {
    expect(
      engineErrorDetailLines({
        issues: [
          null,
          false,
          2,
          "bad",
          {},
          { path: ["ignored"], message: 42 },
          { path: ["steps", 0, "name"], message: "Required" },
          { path: "field", message: "Invalid" },
          { path: 7, message: "Numeric" },
          { path: [], message: "Root" },
          { path: "", message: "Empty path" },
          { message: "No path" },
          { path: "field", message: "" },
        ],
      }),
    ).toEqual([
      "steps.0.name: Required",
      "field: Invalid",
      "7: Numeric",
      "Root",
      "Empty path",
      "No path",
      "field: ",
    ]);
  });
});
