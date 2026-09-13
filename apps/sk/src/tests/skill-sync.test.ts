import { describe, expect, test } from "bun:test";

import {
  MANAGED_MARKER,
  planSync,
  renderSkillMd,
  skillDirName,
  type SyncSkill,
} from "../lib/skill-sync.ts";

function makeSkill(overrides: Partial<SyncSkill> = {}): SyncSkill {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    slug: null,
    title: "Hausstil & Stimme",
    body: "Nie belehrend schreiben.",
    tags: ["domain:blog-de"],
    version: 3,
    ...overrides,
  };
}

describe("skillDirName", () => {
  test("prefers the seed slug", () => {
    expect(skillDirName({ slug: "blog-style", title: "Whatever" })).toBe("blog-style");
  });

  test("kebab-cases German titles with umlaut transliteration", () => {
    expect(skillDirName({ slug: null, title: "Blog-de: Hausstil & Stimme" })).toBe(
      "blog-de-hausstil-stimme",
    );
    expect(skillDirName({ slug: null, title: "Natürliches Deutsch — Übersetzungen" })).toBe(
      "natuerliches-deutsch-uebersetzungen",
    );
  });
});

describe("renderSkillMd", () => {
  test("emits Agent-Skills frontmatter, the managed marker, and the body", () => {
    const md = renderSkillMd(makeSkill({ pitfalls: ["kein ASCII-Umlaut"] }));
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: hausstil-stimme");
    expect(md).toContain("description: Hausstil & Stimme.");
    expect(md).toContain("blog-de domain(s)");
    expect(md).toContain(MANAGED_MARKER);
    expect(md).toContain("v3 -->");
    expect(md).toContain("Nie belehrend schreiben.");
    expect(md).toContain("## Pitfalls\n- kein ASCII-Umlaut");
  });
});

describe("planSync", () => {
  test("writes new skills, keeps unchanged ones, prunes managed leftovers", () => {
    const current = makeSkill();
    const rendered = renderSkillMd(current);
    const existing = new Map<string, string>([
      ["hausstil-stimme", rendered],
      ["old-managed", `---\nname: old-managed\n---\n${MANAGED_MARKER}\nstale`],
      ["hand-authored", "---\nname: hand-authored\n---\nmy own skill"],
    ]);
    const plan = planSync(
      [current, makeSkill({ title: "Neue Regel", id: "x", version: 1 })],
      existing,
    );
    expect([...plan.writes.keys()]).toEqual(["neue-regel"]);
    expect(plan.unchanged).toEqual(["hausstil-stimme"]);
    expect(plan.prunes).toEqual(["old-managed"]);
  });

  test("a changed body becomes a write, never a prune", () => {
    const skill = makeSkill();
    const existing = new Map<string, string>([
      ["hausstil-stimme", renderSkillMd({ ...skill, version: 2, body: "Alte Fassung." })],
    ]);
    const plan = planSync([skill], existing);
    expect([...plan.writes.keys()]).toEqual(["hausstil-stimme"]);
    expect(plan.prunes).toEqual([]);
  });

  test("never prunes hand-authored directories", () => {
    const plan = planSync([], new Map([["hand-authored", "---\nname: x\n---\nno marker"]]));
    expect(plan.prunes).toEqual([]);
    expect(plan.writes.size).toBe(0);
  });
});
