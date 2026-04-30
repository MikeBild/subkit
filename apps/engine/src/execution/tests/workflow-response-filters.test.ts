// Workflow-level response filter integration tests.
//
// Subkit historically applied `response_filters` only at the
// `RequestStep` level (post-HTTP-response, mid-pipeline). For parity
// with the reference impl, `response_filters` declared at the
// `WorkflowDef` root run AFTER `output_transform` so the operator's
// public-payload shape is filtered last, regardless of which step
// produced the data.

import { describe, expect, test } from "bun:test";
import type { ResponseFilter } from "../../workflows/types.ts";
import { applyResponseFilters } from "../response-filter.ts";

describe("workflow-level response_filters", () => {
  test("masks PII keys produced by a transform step", () => {
    // Simulate the post-output_transform payload — what the engine
    // would pass into `applyResponseFilters` at the workflow root.
    const transformedPayload = {
      users: [
        { id: 1, email: "alice@example.com", api_key: "sk-secret-1" },
        { id: 2, email: "bob@example.com", api_key: "sk-secret-2" },
      ],
    };
    const filters: ResponseFilter[] = [{ target: "KEYS", action: "MASK", pattern: "^api_key$" }];
    const out = applyResponseFilters(filters, transformedPayload) as typeof transformedPayload;
    expect(out.users[0]?.api_key).toBe("***redacted***");
    expect(out.users[1]?.api_key).toBe("***redacted***");
    // Non-matched fields untouched.
    expect(out.users[0]?.email).toBe("alice@example.com");
  });

  test("FAIL filters surface as ResponseFilterFailError (engine catches → workflow fails)", async () => {
    const filters: ResponseFilter[] = [{ target: "KEYS", action: "FAIL", pattern: "^ssn$" }];
    const offending = { ssn: "123-45-6789" };
    let threw = false;
    try {
      applyResponseFilters(filters, offending);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("REMOVE strips matched keys without affecting siblings", () => {
    const filters: ResponseFilter[] = [{ target: "KEYS", action: "REMOVE", pattern: "^debug$" }];
    const out = applyResponseFilters(filters, {
      result: "ok",
      debug: { stack: "..." },
    }) as Record<string, unknown>;
    expect(out).toEqual({ result: "ok" });
  });

  test("composes with multiple filters in order", () => {
    const filters: ResponseFilter[] = [
      { target: "KEYS", action: "MASK", pattern: "^password$" },
      { target: "KEYS", action: "REMOVE", pattern: "^_internal$" },
    ];
    const out = applyResponseFilters(filters, {
      user: "alice",
      password: "hunter2",
      _internal: { stack: "private" },
    }) as Record<string, unknown>;
    expect(out).toEqual({ user: "alice", password: "***redacted***" });
  });
});
