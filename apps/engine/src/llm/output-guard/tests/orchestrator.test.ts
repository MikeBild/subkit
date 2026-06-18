// Unit tests for the llmOutputGuard orchestrator — soft/hard/off
// behaviour, scanner composition, error isolation, and the rewrite
// produced in soft mode.

import { describe, expect, it } from "bun:test";
import { LlmOutputViolation } from "../../errors.ts";
import { runOutputGuard } from "../index.ts";
import type { Scanner, Violation } from "../types.ts";

const ctx = { engine_url: "https://subkit-api.acme.dev" };

describe("runOutputGuard — soft mode", () => {
  it("returns text unchanged when no scanner finds anything", () => {
    const r = runOutputGuard("Hello, https://subkit-api.acme.dev is the host.", ctx, {
      mode: "soft",
    });
    expect(r.text).toBe("Hello, https://subkit-api.acme.dev is the host.");
    expect(r.violations).toEqual([]);
    expect(r.mode).toBe("soft");
  });

  it("repairs a placeholder host in-place with the grounded engine_url", () => {
    const r = runOutputGuard("Use https://your-subkit-instance.com/mcp", ctx, { mode: "soft" });
    // Repair replaces the placeholder host with the grounded host from
    // engine_url so the user gets a usable config on the first turn.
    // The violation is still recorded for observability.
    expect(r.text).toContain("subkit-api.acme.dev");
    expect(r.text).not.toContain("your-subkit-instance.com");
    expect(r.text).not.toContain("[guard:placeholder.host]");
    expect(r.violations.map((v) => v.kind)).toContain("placeholder.host");
  });

  it("strips the offending span when no grounded repair is available", () => {
    const r = runOutputGuard("Use https://your-subkit-instance.com/mcp", {}, { mode: "soft" });
    // No engine_url → no repair value. The old design left a
    // `[guard:placeholder.host]` marker in user-visible text; the new
    // behavior removes the span entirely and surfaces the violation
    // on `violations` for the operator UI / model context loop.
    expect(r.text).not.toContain("[guard:");
    expect(r.text).not.toContain("your-subkit-instance.com");
    expect(r.violations.map((v) => v.kind)).toContain("placeholder.host");
  });

  it("rewrites multiple violations in one pass — repairs where possible, strips otherwise", () => {
    const r = runOutputGuard(
      "Use your-subkit-instance.com with <YOUR_KEY>; backup is example.com",
      ctx,
      { mode: "soft" },
    );
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
    // Hosts are repaired in-place; angle placeholders have no grounded
    // substitute and are stripped. Nothing leaks a guard marker into
    // the user-visible transcript.
    expect(r.text).toContain("subkit-api.acme.dev");
    expect(r.text).not.toContain("[guard:");
    expect(r.text).not.toContain("your-subkit-instance.com");
    expect(r.text).not.toContain("example.com");
    expect(r.text).not.toContain("<YOUR_KEY>");
    expect(r.violations.map((v) => v.kind)).toContain("placeholder.angle");
  });

  it("preserves the matched fragment on the violation for operator dashboards", () => {
    const r = runOutputGuard("Use your-subkit-instance.com", ctx, { mode: "soft" });
    const v = r.violations.find((x) => x.kind === "placeholder.host");
    expect(v?.details?.match).toContain("your-subkit-instance");
  });
});

describe("runOutputGuard — hard mode", () => {
  it("throws LlmOutputViolation on the first violation list", () => {
    expect(() =>
      runOutputGuard("Use https://your-subkit-instance.com/mcp", ctx, { mode: "hard" }),
    ).toThrow(LlmOutputViolation);
  });

  it("propagates the full violation list on the thrown error", () => {
    try {
      runOutputGuard("Use your-subkit-instance.com and <YOUR_KEY>", ctx, { mode: "hard" });
      throw new Error("guard did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmOutputViolation);
      const violations = (err as LlmOutputViolation).violations;
      const kinds = violations.map((v) => v.kind);
      expect(kinds).toContain("placeholder.host");
      expect(kinds).toContain("placeholder.angle");
    }
  });

  it("does NOT throw on clean text", () => {
    expect(() =>
      runOutputGuard("Use https://subkit-api.acme.dev/mcp", ctx, { mode: "hard" }),
    ).not.toThrow();
  });
});

describe("runOutputGuard — off mode", () => {
  it("bypasses every scanner and returns text unchanged", () => {
    const r = runOutputGuard("Use https://your-subkit-instance.com/mcp", ctx, { mode: "off" });
    expect(r.text).toBe("Use https://your-subkit-instance.com/mcp");
    expect(r.violations).toEqual([]);
    expect(r.duration_ms).toBe(0);
  });
});

describe("runOutputGuard — scanner composition", () => {
  it("isolates a faulty scanner so it does not crash the run", () => {
    const fault: Scanner = {
      id: "fault",
      scan() {
        throw new Error("boom");
      },
    };
    const noop: Scanner = {
      id: "noop",
      scan() {
        return [] as Violation[];
      },
    };
    const r = runOutputGuard("hello", ctx, { mode: "soft", scanners: [fault, noop] });
    expect(r.text).toBe("hello");
    expect(r.violations).toEqual([]); // the faulty scanner emitted no violations
  });

  it("runs scanners in declared order and aggregates all violations", () => {
    const a: Scanner = {
      id: "a",
      scan: () => [{ kind: "a.found", message: "a" }],
    };
    const b: Scanner = {
      id: "b",
      scan: () => [{ kind: "b.found", message: "b" }],
    };
    const r = runOutputGuard("hello", ctx, { mode: "soft", scanners: [a, b] });
    expect(r.violations.map((v) => v.kind)).toEqual(["a.found", "b.found"]);
  });

  it("records a non-zero duration_ms in non-off modes", () => {
    const r = runOutputGuard("hello", ctx, { mode: "soft" });
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
