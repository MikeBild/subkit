import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "steps", "request", "http-attempt.ts");

describe("http request driver · retry telemetry shape", () => {
  const body = readFileSync(SRC, "utf-8");

  test("emits attempt_no on every retry log", () => {
    const occurrences = body.match(/attempt_no:\s*attempt/g);
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("emits total_attempts on every retry log", () => {
    const occurrences = body.match(/total_attempts:\s*p\.max_attempts/g);
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("emits delay_ms (not wait_ms) on every retry log", () => {
    expect(body).toMatch(/delay_ms:\s*Math\.round\(wait\)/);
    expect(body).not.toMatch(/wait_ms:\s*Math\.round\(wait\)/);
  });

  test("emits next_attempt_at ISO timestamp", () => {
    expect(body).toMatch(
      /next_attempt_at:\s*new Date\((?:p\.clock\.now|rateLimitNow)\(\) \+ wait\)\.toISOString\(\)/,
    );
  });

  test("includes connector_id label so retries can be aggregated per connector", () => {
    const occurrences = body.match(/connector_id:\s*p\.connector_id/g);
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("retry-after header value is logged on http_429", () => {
    expect(body).toContain("retry_after_header");
  });
});
