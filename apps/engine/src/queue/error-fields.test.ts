import { expect, test } from "bun:test";
import { errorFields } from "../logging/logger.ts";
import { queueErrorFields } from "./error-fields.ts";

test("plain worker error envelopes retain diagnostics without job payloads", () => {
  const fields = queueErrorFields({
    message: "Connection terminated unexpectedly",
    code: "08006",
    queue: "private-queue",
    worker: "private-worker",
    job: { token: "private-job-canary" },
  });
  expect(fields).toEqual({
    error: "database query failed",
    error_class: "transient",
    sqlstate: "08006",
  });
});

test("plain timeout envelopes preserve their message and classification", () => {
  expect(
    queueErrorFields({
      message: "Worker connection timed out",
      name: "TimeoutError",
      stack: "TimeoutError: Worker connection timed out\n    at worker",
    }),
  ).toEqual({
    error: "Worker connection timed out",
    error_class: "timeout",
    stack: "TimeoutError: Worker connection timed out\n    at worker",
  });
});

test("query envelopes discard parameter values and unsafe SQLSTATE details", () => {
  const fields = queueErrorFields({
    message: "Failed query: select private_column\nparams: private-query-canary",
    stack: "private-stack-canary",
    code: "22P02",
    cause: { message: "private-cause-canary", query: "private-query-canary" },
  });
  expect(fields).toEqual({
    error: "database query failed",
    error_class: "validation",
    cause: "database error cause omitted",
  });
  expect(JSON.stringify(fields)).not.toContain("private-");
});

test("native errors retain existing nested-cause sanitization", () => {
  const cause = Object.assign(new Error("private-cause-canary"), { code: "23505" });
  const error = new Error("Worker failed", { cause });
  expect(queueErrorFields(error)).toEqual(errorFields(error));
  expect(JSON.stringify(queueErrorFields({ message: "Worker failed", cause }))).not.toContain(
    "private-cause-canary",
  );
});

test("unrecognized payloads cannot invoke custom string serialization", () => {
  const fields = queueErrorFields({ toString: () => "private-canary" });
  expect(fields).toMatchObject({
    error: "Unknown queue error",
    error_class: "unknown",
  });
  expect(JSON.stringify(fields)).not.toContain("private-canary");
  expect(queueErrorFields(null).error).toBe("Unknown queue error");
  expect(queueErrorFields("Worker stopped").error).toBe("Worker stopped");
});

test.each(["42501", "28P01"])(
  "nested supervisor errors retain safe SQLSTATE %s without database contents",
  (code) => {
    const native = Object.assign(new Error("private-database-canary"), {
      code,
      detail: "private-detail-canary",
    });
    for (const nested of [native, { message: native.message, code, detail: native.detail }]) {
      const fields = queueErrorFields({
        message: "private-wrapper-canary",
        stack: "private-stack-canary",
        cause: { message: "private-middle-canary", cause: nested },
        job: { token: "private-job-canary" },
      });
      expect(fields).toMatchObject({
        error: "database query failed",
        error_class: "upstream_auth",
        sqlstate: code,
      });
      expect(JSON.stringify(fields)).not.toContain("private-");
      expect(fields.stack).toBeUndefined();
    }
    const fields = queueErrorFields(new Error("private-wrapper-canary", { cause: native }));
    expect(fields.sqlstate).toBe(code);
    expect(JSON.stringify(fields)).not.toContain("private-");
  },
);

test("cyclic supervisor error causes are bounded without exposing their payload", () => {
  const cause: { message: string; cause?: unknown; payload: string } = {
    message: "Worker stopped",
    payload: "private-cycle-canary",
  };
  cause.cause = cause;
  expect(JSON.stringify(queueErrorFields({ message: "Worker stopped", cause }))).not.toContain(
    "private-cycle-canary",
  );
});
