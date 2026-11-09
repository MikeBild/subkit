import { expect, test } from "bun:test";
import { workflowAuthorityExecutionOptions, workflowAuthorityOptionsDigest } from "./authority.ts";

const defaults = Object.freeze({
  workflow_timeout_ms: 100,
  request_timeout_ms: 20,
  request_max_retries: 3,
});

test("authority options pin reviewed dispatch behavior in either environment", () => {
  for (const environment of ["dev", "prod"] as const)
    expect(workflowAuthorityExecutionOptions(environment)).toEqual({
      execution_mode: environment,
      self_healing: { enabled: false },
      hold_writes: false,
    });
});

test("preview digest preserves the previous canonical payload and binds every execution default", () => {
  const digest = workflowAuthorityOptionsDigest("prod", defaults);
  expect(digest).toBe("4afca2606fc062caf017feff687f58e5192be470a71b41ebf4ec9d863cbccc39");
  expect(workflowAuthorityOptionsDigest("dev", defaults)).not.toBe(digest);
  for (const field of ["workflow_timeout_ms", "request_timeout_ms", "request_max_retries"] as const)
    expect(
      workflowAuthorityOptionsDigest("prod", { ...defaults, [field]: defaults[field] + 1 }),
    ).not.toBe(digest);
  expect(workflowAuthorityOptionsDigest("prod", defaults)).toBe(digest);
  expect(defaults).toEqual({
    workflow_timeout_ms: 100,
    request_timeout_ms: 20,
    request_max_retries: 3,
  });
});
