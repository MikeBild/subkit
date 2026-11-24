import { describe, expect, test } from "bun:test";
import { setupCheck } from "../../commands/doctor-checks.ts";

const COUNTS = { blockers: 1, warnings: 2, sections_blocked: 1, sections_warn: 1 };

describe("setup check", () => {
  test("blocked or warn setup points to `subkit diagnostics setup`, not back to doctor", () => {
    for (const overall_status of ["blocked", "warn"] as const) {
      const result = setupCheck({ overall_status, summary_counts: COUNTS });
      expect(result.status).toBe(overall_status);
      expect(result.hint).toContain("subkit diagnostics setup");
      expect(result.hint).not.toContain("subkit doctor");
    }
  });

  test("ok setup has no hint", () => {
    const result = setupCheck({
      overall_status: "ok",
      summary_counts: { blockers: 0, warnings: 0, sections_blocked: 0, sections_warn: 0 },
    });
    expect(result).toEqual({
      name: "setup",
      status: "ok",
      detail: "overall=ok blockers=0 warnings=0 sections_blocked=0 sections_warn=0",
    });
  });
});
