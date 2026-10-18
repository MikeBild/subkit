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
