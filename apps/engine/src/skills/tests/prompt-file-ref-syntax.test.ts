// C25: Skill prompts use `$file` (not `@attachment:`) as the file-reference syntax.
//
// CONTRACT STATUS: GREEN (with one intentional operator-facing carve-out)
//
// The plan §C25 stated: "skill prompts use `$file` (not `@attachment:`)".
//
// FINDING: attachment-handling.md contains one occurrence of `@attachment:` —
// but it is NOT used as a reference token inside a skill. It is part of
// operator-facing documentation explaining that USERS may TYPE `@attachment:<slug>`
// in chat text, and the engine rewrites it to a `$file` ref at message ingest.
// This is the correct behavior description of the rewrite layer, not a skill
// emitting the legacy token in a tool input.
//
// The test therefore:
//   1. Scans every .md under the skills/content/ directory.
//   2. Asserts NO occurrence of `@attachment:` appears EXCEPT in lines that
//      are describing the user-input rewrite behavior (i.e., contain the
//      word "rewrites" or "user may also type").
//   3. Asserts the attachment-handling.md uses `$file` as the canonical shape.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const SKILL_CONTENT_DIR = join(import.meta.dir, "../../conversations/agent/skills/content");

// Lines that describe user-input rewriting are operator-facing documentation.
// They mention @attachment: but do not use it as a file-reference token in a
// tool input — the engine rewrites them before they reach any skill.
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

        // Exclude lines that are documenting the rewrite behaviour —
        // these describe what the USER types in chat, not what the skill does.
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
    // The canonical reference shape must appear in the skill prompt.
    expect(attachmentPrompt!.content).toContain("$file");
    // The prompt must NOT instruct the model to emit raw @attachment: refs.
    // (The @attachment: that does appear is in a description of user input,
    // not a model output instruction — verified by the test above.)
    expect(attachmentPrompt!.content).not.toMatch(/emit.*@attachment:|output.*@attachment:/i);
  });

  test("all skill prompts are non-empty (no accidentally truncated files)", () => {
    for (const { filename, content } of prompts) {
      expect(content.trim().length, `${filename} must be non-empty`).toBeGreaterThan(10);
    }
  });
});
