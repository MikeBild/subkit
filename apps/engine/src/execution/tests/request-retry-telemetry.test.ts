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

  // Timeout classification (2026-06-21 Gmail send outage): a per-request
  // timeout must be terminal, not a retryable connection error. Without
  // this, a `POST /messages/send` that stalled for the full budget was
  // retried 5× (~23 min) and risked double-sending the email.
  test("recognises TimeoutError as a timeout (not a connection error)", () => {
    expect(body).toMatch(/e\.name === "TimeoutError"/);
    expect(body).toMatch(/timed out\|timeout/);
  });

  test("classifies a per-request timeout as terminal (cause_kind 'timeout' is thrown, never retried)", () => {
    expect(body).toMatch(/err\.cause_kind === "timeout"\) throw err/);
  });

  test("the timeout branch precedes the connection-error retry fallthrough", () => {
    const timeoutIdx = body.indexOf(
      'throw new RequestError(e.message ?? "operation timed out", "timeout")',
    );
    const connIdx = body.indexOf("connection error: retry regardless of method");
    expect(timeoutIdx).toBeGreaterThan(0);
    expect(connIdx).toBeGreaterThan(0);
    expect(timeoutIdx).toBeLessThan(connIdx);
  });
});
