import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_CONTENT_DIR = join(import.meta.dir, "../../conversations/agent/skills/content");

const REWRITE_DOCUMENTATION_PATTERN =
  /rewrites?\s+that\s+token|user\s+may\s+also\s+type|the\s+engine\s+rewrites/i;

function loadSkillPrompts(): Array<{ filename: string; content: string }> {
  const entries = readdirSync(SKILL_CONTENT_DIR);
  return entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      filename: f,
      content: readFileSync(join(SKILL_CONTENT_DIR, f), "utf8"),
    }));
}

describe("C25 — skill prompt file-reference syntax", () => {
  const prompts = loadSkillPrompts();

  test("skills/content/ directory contains at least one skill prompt", () => {
    expect(prompts.length).toBeGreaterThan(0);
  });

  test("no skill prompt emits @attachment: as a tool-input reference token", () => {
    const violations: string[] = [];

    for (const { filename, content } of prompts) {
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.includes("@attachment:")) continue;

        if (REWRITE_DOCUMENTATION_PATTERN.test(line)) continue;

        violations.push(`${filename}: ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Skill prompts using legacy @attachment: token (not in rewrite-doc context):\n${violations.join("\n")}`,
      );
    }
  });

  test("attachment-handling.md uses $file as the canonical reference shape", () => {
    const attachmentPrompt = prompts.find((p) => p.filename === "attachment-handling.md");
    expect(attachmentPrompt).toBeDefined();
    expect(attachmentPrompt!.content).toContain('{ "$file": "fid_<uuid>" }');
  });

  test("attachment-handling.md documents the $file shape for tool inputs", () => {
    const attachmentPrompt = prompts.find((p) => p.filename === "attachment-handling.md");
    expect(attachmentPrompt).toBeDefined();
    expect(attachmentPrompt!.content).toContain("$file");
    expect(attachmentPrompt!.content).not.toMatch(/emit.*@attachment:|output.*@attachment:/i);
  });

  test("all skill prompts are non-empty (no accidentally truncated files)", () => {
    for (const { filename, content } of prompts) {
      expect(content.trim().length, `${filename} must be non-empty`).toBeGreaterThan(10);
    }
  });
});
