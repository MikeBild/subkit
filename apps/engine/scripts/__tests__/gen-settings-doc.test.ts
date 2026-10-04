import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "gen-settings-doc.ts");

function runOnce(): string {
  const result = spawnSync("bun", ["run", SCRIPT], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("gen-settings-doc", () => {
  test("output is byte-stable across two runs", () => {
    const a = runOnce();
    const b = runOnce();
    expect(a).toBe(b);
  });

  test("output documents every leaf in the schema and includes the auto-generated header", () => {
    const out = runOnce();
    expect(out.startsWith("<!-- AUTO-GENERATED")).toBe(true);
    expect(out).toContain("`database.url`");
    expect(out).toContain("`llm.providers.anthropic.api_key`");
    expect(out).toContain("`auth.session.secret`");
    expect(out).toContain("`tokens.monthly_budget`");
  });
});
