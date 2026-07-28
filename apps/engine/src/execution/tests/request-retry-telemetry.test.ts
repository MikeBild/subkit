// Uniform retry telemetry. Every retry attempt emits the
// same shape: attempt_no, total_attempts, delay_ms, next_attempt_at,
// reason. Pre-fix the log fields were `attempt` / `wait_ms` and
// missing `total_attempts` — operators couldn't reconstruct the
// retry timeline from logs alone.
//
// We assert source-level wiring (every `request.retry` log call has
// the new shape) so a future refactor can't silently regress to the
// old field names.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The retry-telemetry log calls live in `request/dispatch.ts`; the
// top-level `request.ts` is a barrel re-exporter only.
const SRC = join(import.meta.dir, "..", "steps", "request", "dispatch.ts");

describe("request driver · retry telemetry shape", () => {
  const body = readFileSync(SRC, "utf-8");

  test("emits attempt_no on every retry log", () => {
    // Three reasons: http_429, http_5xx, http_4xx_opt_in,
    // connection_error. Each must populate attempt_no.
    const occurrences = body.match(/attempt_no:\s*attempt/g);
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("emits total_attempts on every retry log", () => {
    const occurrences = body.match(/total_attempts:\s*p\.max_attempts/g);
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("emits delay_ms (not wait_ms) on every retry log", () => {
    expect(body).toMatch(/delay_ms:\s*Math\.round\(wait\)/);
    // The legacy `wait_ms` should no longer appear in retry logs.
    expect(body).not.toMatch(/wait_ms:\s*Math\.round\(wait\)/);
  });

  test("emits next_attempt_at ISO timestamp", () => {
    expect(body).toMatch(/next_attempt_at:\s*new Date\(Date\.now\(\) \+ wait\)\.toISOString\(\)/);
  });

  test("includes connector_id label so retries can be aggregated per connector", () => {
    const occurrences = body.match(/connector_id:\s*p\.connector_id/g);
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("retry-after header value is logged on http_429", () => {
    expect(body).toContain("retry_after_header");
  });

  // The per-request timeout classification (a stalled `POST /messages/send`
  // must be terminal, not retried 5×) is proven by
  // `request-timeout-classify.test.ts`, which asserts the pure classifier
  // directly — it replaced an earlier behavioural test that proved the same
  // thing but was flaky. No brittle source-text assertion is kept here.
});
