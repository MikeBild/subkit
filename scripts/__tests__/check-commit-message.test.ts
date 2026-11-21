import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "check-commit-message.sh");

function check(message: string): number {
  const dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  return Bun.spawnSync(["bash", script, file]).exitCode;
}

describe("commit message check", () => {
  test("a conventional message passes", () => {
    expect(check("fix(engine): a thing works again\n\nThe reason.\n")).toBe(0);
  });

  test("a model name in the body is fine", () => {
    expect(check("feat(llm): offer claude-sonnet models\n\nAdds the claude-sonnet family.\n")).toBe(
      0,
    );
  });

  test("an assistant session line is refused", () => {
    expect(check("fix: a thing\n\nClaude-Session: https://claude.ai/code/session_x\n")).toBe(1);
  });

  test("an assistant co-author line is refused", () => {
    expect(check("feat: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")).toBe(1);
  });

  test("a generated-with line is refused", () => {
    expect(
      check("chore: z\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"),
    ).toBe(1);
  });

  test("comment lines from the editor are ignored", () => {
    expect(check("fix: a thing\n\n# Claude-Session: ignored comment\n")).toBe(0);
  });
});
