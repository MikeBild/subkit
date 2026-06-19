// Redaction gate for the claude-review comment scrubber. The workflow
// pipes the model's review output through this script before posting,
// so a regression here would expose secrets to a public PR thread.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scrub-review-comment.ts");

function scrub(input: string): string {
  const result = spawnSync("bun", ["run", SCRIPT], { input, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("scrub-review-comment", () => {
  test("masks GitHub PATs", () => {
    const out = scrub("token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234");
    expect(out).not.toContain("ghp_AAAA");
    expect(out).toContain("***REDACTED:pat***");
  });

  test("masks Anthropic keys", () => {
    const out = scrub("ANTHROPIC_API_KEY=sk-ant-api01-abcdefghijklmnopqrstuv");
    expect(out).not.toContain("sk-ant-api01-abcd");
    expect(out).toContain("***REDACTED:pat***");
  });

  test("masks AWS access keys", () => {
    const out = scrub("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("***REDACTED:aws_key***");
  });

  test("masks JWTs", () => {
    const out = scrub("Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0");
    expect(out).toContain("***REDACTED:jwt***");
  });

  test("masks bearer tokens", () => {
    const out = scrub("curl -H 'Authorization: Bearer abc.def-ghi_jkl'");
    expect(out).not.toContain("Bearer abc.def-ghi_jkl");
    expect(out).toContain("***REDACTED:bearer***");
  });

  test("preserves non-secret content", () => {
    const body =
      "## Summary\n\nThis PR adds a new route at `apps/engine/src/http/routes/foo.ts`.\n";
    expect(scrub(body)).toBe(body);
  });

  test("exits non-zero on empty stdin", () => {
    const result = spawnSync("bun", ["run", SCRIPT], { input: "", encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stdin was empty");
  });

  test("exits non-zero on whitespace-only stdin", () => {
    const result = spawnSync("bun", ["run", SCRIPT], { input: "   \n\n\t  ", encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });

  test("scrubs multiple secrets in the same body", () => {
    const body = [
      "Found in the diff:",
      "  ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234",
      "  AKIAIOSFODNN7EXAMPLE",
      "  Bearer xyz.abc-def_ghi",
    ].join("\n");
    const out = scrub(body);
    expect(out).not.toContain("ghp_AAAA");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("Bearer xyz.abc-def_ghi");
  });

  test("fail-closed contract: a non-zero exit MUST be observable to the workflow", () => {
    // The workflow's `Scrub secrets from review body` step relies on
    // a non-zero exit to trigger the diagnostic-placeholder fallback
    // (and the ::error:: annotation). If a future "make this resilient"
    // change makes the script swallow errors and exit 0, the workflow
    // would post the raw body — exactly the leak the gate exists to
    // prevent.
    //
    // This test pins the contract: ANY input that the script refuses
    // MUST produce a non-zero exit code AND a stderr message. Today
    // empty / whitespace-only stdin is the only refusal class; if
    // future scrubber changes add other refusals, extend this list.
    for (const refusedInput of ["", "   \n\n\t  "]) {
      const result = spawnSync("bun", ["run", SCRIPT], {
        input: refusedInput,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });
});
