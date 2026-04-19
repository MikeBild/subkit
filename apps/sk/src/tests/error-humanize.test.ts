import { describe, expect, it } from "bun:test";
import { humanizeValidationError, summarizeToolFailure } from "../repl/error-humanize.ts";

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
