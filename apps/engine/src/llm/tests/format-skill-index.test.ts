// Unit tests for formatSkillIndex — the per-scope index block that
// renders ambient (applicable-but-not-loaded) skills as one compact
// catalog block. Mirror of the validated reference-impl pattern:
// system prompt ships the index, the LLM calls load_skill(<slug>) to
// retrieve full bodies on demand.

import { describe, expect, test } from "bun:test";
import type { Skill } from "../../skills/types.ts";
import { formatSkillIndex } from "../core/context-assembler.ts";

function fakeSkill(overrides: Partial<Skill> & { id: string; title: string }): Skill {
  return {
    tenant_id: "t",
    scope: "global",
    connector_id: null,
    workflow_id: null,
    slug: null,
    body: "",
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    status: "active",
    source: "manual",
    version: 1,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

describe("formatSkillIndex", () => {
  test("returns null for an empty input — no header / no empty block", () => {
    expect(formatSkillIndex("Global", [])).toBeNull();
  });

  test("renders one line per skill with slug + title + first description line", () => {
    const block = formatSkillIndex("Global", [
      fakeSkill({
        id: "id-a",
        slug: "workflow-authoring",
        title: "Workflow Authoring",
        body: "# Workflow Authoring\n\nHow to compose a typed WorkflowDef.\nMore detail follows.",
      }),
      fakeSkill({
        id: "id-b",
        slug: "data-handling",
        title: "Data Handling",
        body: "JSONata, transforms, and step-output shaping.",
      }),
    ]);
    expect(block).not.toBeNull();
    if (!block) return;
    expect(block).toContain("Global skill index");
    expect(block).toContain("`workflow-authoring`");
    expect(block).toContain("Workflow Authoring");
    expect(block).toContain("How to compose a typed WorkflowDef.");
    expect(block).toContain("`data-handling`");
    expect(block).toContain("JSONata, transforms, and step-output shaping.");
    // load_skill hint is in the header line
    expect(block).toContain("load_skill('<slug>')");
  });

  test("falls back to id when slug is null — never null/undefined ref", () => {
    const block = formatSkillIndex("Workflow", [
      fakeSkill({
        id: "raw-uuid-1",
        slug: null,
        title: "Manual Skill",
        body: "Operator-authored guidance.",
      }),
    ]);
    expect(block).toContain("`raw-uuid-1`");
    expect(block).not.toContain("`null`");
    expect(block).not.toContain("`undefined`");
  });

  test("first line skips H1/H2/H3 markdown headings to find a real description", () => {
    const block = formatSkillIndex("Connector", [
      fakeSkill({
        id: "id-1",
        slug: "auth-flows",
        title: "Auth Flows",
        body: "# Auth Flows\n## Overview\n\nAuth modes by template type.",
      }),
    ]);
    expect(block).toContain("Auth modes by template type.");
    expect(block).not.toMatch(/—\s*Auth Flows:\s*#/);
  });

  test("description is truncated at 120 chars with an ellipsis", () => {
    const longLine = "x".repeat(200);
    const block = formatSkillIndex("Global", [
      fakeSkill({ id: "id-long", slug: "long", title: "Long", body: longLine }),
    ]);
    expect(block).not.toBeNull();
    if (!block) return;
    // Header + one entry. Find the entry line.
    const entryLine = block.split("\n").find((l) => l.startsWith("- "));
    expect(entryLine).toBeDefined();
    if (!entryLine) return;
    // Title is "Long", the description portion should be truncated.
    expect(entryLine).toContain("…");
    // Entry line shouldn't contain the full 200-char string.
    expect(entryLine.length).toBeLessThan(200);
  });

  test("skills with empty bodies still appear in the index — slug+title only", () => {
    const block = formatSkillIndex("Global", [
      fakeSkill({ id: "id-empty", slug: "empty", title: "Empty Skill", body: "" }),
    ]);
    expect(block).toContain("`empty`");
    expect(block).toContain("Empty Skill");
    // No trailing colon when there's no description.
    expect(block).not.toContain("Empty Skill: ");
  });

  test("scales linearly — 50 skills produce 50 entry lines, no duplicates", () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      fakeSkill({
        id: `id-${i}`,
        slug: `skill-${i}`,
        title: `Skill ${i}`,
        body: `Description for skill ${i}.`,
      }),
    );
    const block = formatSkillIndex("Global", skills);
    expect(block).not.toBeNull();
    if (!block) return;
    const entries = block.split("\n").filter((l) => l.startsWith("- "));
    expect(entries).toHaveLength(50);
    // Each ref appears exactly once.
    for (let i = 0; i < 50; i++) {
      const matches = block.match(new RegExp(`\`skill-${i}\``, "g"));
      expect(matches).not.toBeNull();
      expect(matches?.length).toBe(1);
    }
  });

  test("runtime_context tokens are substituted in the description", () => {
    const block = formatSkillIndex(
      "Global",
      [
        fakeSkill({
          id: "id-r",
          slug: "runtime-aware",
          title: "Runtime Aware",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal $-curly tokens are the input shape applyRuntimeTemplate replaces
          body: "Engine URL is ${engine_url} and tenant is ${tenant_slug}.",
        }),
      ],
      {
        engine_url: "http://localhost:3000",
        tenant_slug: "default",
      },
    );
    expect(block).toContain("Engine URL is http://localhost:3000");
    expect(block).toContain("tenant is default");
    expect(block).not.toContain("$" + "{engine_url}");
  });
});
