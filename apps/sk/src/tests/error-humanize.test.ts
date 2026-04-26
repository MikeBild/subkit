import { describe, expect, it, test } from "bun:test";
import { SkEngineError, SkTransportError } from "../engine-client.ts";
import {
  findErrorHint,
  humanizeRequestError,
  humanizeValidationError,
  summarizeToolFailure,
} from "../repl/error-humanize.ts";

describe("humanizeValidationError", () => {
  it("translates a steps.N.kind error into a 1-based step label + valid-kinds hint", () => {
    const r = humanizeValidationError({ path: "steps.0.kind", message: "Invalid input" });
    expect(r.label).toBe("Step 1: invalid `kind`");
    expect(r.detail).toContain("steps.0.kind");
    expect(r.hint).toContain("request");
    expect(r.hint).toContain("tool");
  });

  it("handles a step-root error without losing the message", () => {
    const r = humanizeValidationError({
      path: "steps.2",
      message: "duplicate step id",
    });
    expect(r.label).toBe("Step 3: duplicate step id");
  });

  it("handles a step-field error", () => {
    const r = humanizeValidationError({
      path: "steps.1.url",
      message: "url must start with http:// or https://",
    });
    expect(r.label).toBe("Step 2: url — url must start with http:// or https://");
  });

  it("falls back to the raw message when the path is unknown", () => {
    const r = humanizeValidationError({ path: "name", message: "Required" });
    expect(r.label).toBe("Required");
    expect(r.detail).toBe("name");
  });
});

describe("summarizeToolFailure", () => {
  it("flags the wrong-key case loudly", () => {
    const r = summarizeToolFailure("propose_step", {
      used_wrong_key: true,
      attempted_kind: "trigger.manual",
      errors: [{ path: "steps.0.kind", message: "Invalid input" }],
      valid_kinds: ["request"],
    });
    expect(r.label).toContain("wrong key");
    expect(r.label).toContain("`kind`");
    expect(r.hint).toContain("trigger.manual");
  });

  it("flags an invalid kind with the valid-kinds hint", () => {
    const r = summarizeToolFailure("propose_step", {
      used_wrong_key: false,
      attempted_kind: "flow.approval",
      errors: [{ path: "steps.0.kind", message: "Invalid input" }],
    });
    expect(r.label).toContain("`flow.approval`");
    expect(r.label).toContain("not a valid kind");
    expect(r.hint).toContain("request");
  });

  it("returns the {error: string} shape verbatim", () => {
    const r = summarizeToolFailure("foo", { error: "boom" });
    expect(r.label).toBe("boom");
  });

  it("falls back to generic copy when the payload is unrelated", () => {
    const r = summarizeToolFailure("foo", { ok: false });
    expect(r.label).toBe("foo failed");
  });
});

describe("findErrorHint pattern table", () => {
  test("matches the auth/expired-token pattern", () => {
    expect(findErrorHint("invalid_grant: token has expired")).toMatch(/auth refresh/);
    expect(findErrorHint("HTTP 401 unauthorized")).toMatch(/auth refresh/);
  });

  test("matches the rate-limit pattern", () => {
    expect(findErrorHint("HTTP 429 too many requests")).toMatch(/rate limited/);
    expect(findErrorHint("rate-limit exceeded")).toMatch(/rate limited/);
  });

  test("matches the monthly-budget pattern", () => {
    expect(findErrorHint("monthly_budget exhausted")).toMatch(/budget exhausted/);
    expect(findErrorHint("quota exceeded")).toMatch(/budget/);
  });

  test("matches the scope-envelope pattern", () => {
    expect(findErrorHint("scope_envelope_field_missing: $scope.fetch.items")).toMatch(
      /\.data` envelope/,
    );
  });

  test("matches the network-unreachable pattern", () => {
    expect(findErrorHint("fetch failed: ECONNREFUSED 127.0.0.1:3000")).toMatch(/unreachable/);
    expect(findErrorHint("ETIMEDOUT")).toMatch(/unreachable/);
  });

  test("matches the missing-template pattern", () => {
    expect(findErrorHint("template hubspot not found")).toMatch(/template_slug/);
    expect(findErrorHint("template_slug must be present")).toMatch(/template_slug/);
  });

  test("matches the loop-guard pattern", () => {
    expect(findErrorHint("turn_loop_budget_exhausted after 2 warnings")).toMatch(/loop guard/);
  });

  test("returns null for unrecognised messages", () => {
    expect(findErrorHint("random unrelated error message")).toBeNull();
  });
});

describe("humanizeRequestError surfaces hints", () => {
  test("HTTP 401 SkEngineError carries the auth hint", () => {
    const err = new SkEngineError(401, { code: "unauthorized", message: "invalid_grant" });
    const out = humanizeRequestError(err);
    expect(out).toContain("HTTP 401");
    expect(out).toContain("auth refresh");
  });

  test("provider-limited errors prefer the provider hint over the budget hint", () => {
    const err = new SkEngineError(429, {
      code: "llm_provider_limited",
      message:
        "You have reached your specified API usage limits. You will regain access on 2026-05-01 at 00:00 UTC.",
      details: { retry_at: "2026-05-01T00:00:00.000Z" },
    });
    const out = humanizeRequestError(err);
    expect(out).toContain("llm_provider_limited");
    expect(out).toContain("provider usage limit reached");
    expect(out).toContain("2026-05-01T00:00:00.000Z");
    expect(out).not.toContain("monthly budget exhausted");
  });

  test("provider-unavailable errors get a provider-specific hint", () => {
    const err = new SkEngineError(503, {
      code: "llm_provider_unavailable",
      message: "upstream overloaded",
    });
    const out = humanizeRequestError(err);
    expect(out).toContain("provider temporarily unavailable");
  });

  test("pending elicitation conflicts explain that the open dialog must be resolved", () => {
    const err = new SkEngineError(409, {
      code: "pending_elicitation_blocked",
      message: "resolve the pending dialog before sending another prompt",
    });
    const out = humanizeRequestError(err);
    expect(out).toContain("pending_elicitation_blocked");
    expect(out).toContain("resolve the open dialog first");
  });

  test("transport error matching a known pattern uses the matched hint", () => {
    const err = new SkTransportError(new Error("fetch failed: ECONNREFUSED"));
    const out = humanizeRequestError(err);
    expect(out).toContain("cannot reach engine");
    expect(out).toContain("unreachable");
  });

  test("generic Error with matching message gets a hint line", () => {
    const out = humanizeRequestError(new Error("turn_loop_budget_exhausted"));
    expect(out).toContain("loop guard");
  });

  test("generic Error without match prints the raw message only", () => {
    const out = humanizeRequestError(new Error("something opaque"));
    expect(out).toBe("sk: something opaque");
  });
});
