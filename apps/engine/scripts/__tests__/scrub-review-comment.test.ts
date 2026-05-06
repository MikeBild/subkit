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
});
