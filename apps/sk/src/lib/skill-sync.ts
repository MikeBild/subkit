// Materialize sk skills as Agent-Skills-standard SKILL.md directories for
// Claude Code (`.claude/skills/`) and Codex (`.agents/skills/`). Pure
// planning logic — the `sk skills sync` command does the I/O around it.
//
// Managed-marker contract: sync only ever creates, updates, or prunes
// directories whose SKILL.md carries the MANAGED_MARKER comment. A
// hand-authored project skill without the marker is never touched.

export const SKILL_TARGET_DIRS = [".claude/skills", ".agents/skills"] as const;
export const MANAGED_MARKER = "<!-- managed-by: sk — do not edit; run `sk skills sync` -->";

export interface SyncSkill {
  id: string;
  slug: string | null;
  title: string;
  body: string;
  tags: string[];
  version: number;
  pitfalls?: string[];
  best_practices?: string[];
}

/** Stable directory name: seed slug when present, else kebab-cased title. */
export function skillDirName(skill: Pick<SyncSkill, "slug" | "title">): string {
  if (skill.slug) return skill.slug;
  const kebab = skill.title
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return kebab || "skill";
}

export function renderSkillMd(skill: SyncSkill): string {
  const domains = skill.tags.filter((t) => t.startsWith("domain:"));
  const domainNote =
    domains.length > 0
      ? ` Applies when working in the ${domains.map((d) => d.slice("domain:".length)).join(", ")} domain(s).`
      : "";
  // The description drives the agent's implicit skill activation — it must
  // say WHEN to reach for the skill, not just what it is.
  const description = `${skill.title}.${domainNote} Curated convention from the sk engine.`;
  const lines = [
    "---",
    `name: ${skillDirName(skill)}`,
    `description: ${description.replace(/\n/g, " ")}`,
    "---",
    MANAGED_MARKER,
    `<!-- sk skill ${skill.id} v${skill.version} -->`,
    "",
    skill.body.trim(),
  ];
  if (skill.best_practices && skill.best_practices.length > 0) {
    lines.push("", "## Best practices", ...skill.best_practices.map((b) => `- ${b}`));
  }
  if (skill.pitfalls && skill.pitfalls.length > 0) {
    lines.push("", "## Pitfalls", ...skill.pitfalls.map((p) => `- ${p}`));
  }
  return `${lines.join("\n")}\n`;
}

export interface SyncPlan {
  /** dir name → SKILL.md content to write (created or changed). */
  writes: Map<string, string>;
  /** dir names unchanged on disk. */
  unchanged: string[];
  /** managed dir names to remove (skill archived/untagged since last sync). */
  prunes: string[];
}

/**
 * Plan one target directory's sync. `existing` maps dir name → current
 * SKILL.md content (only entries that exist on disk).
 */
export function planSync(skills: SyncSkill[], existing: Map<string, string>): SyncPlan {
  const desired = new Map<string, string>();
  for (const skill of skills) {
    desired.set(skillDirName(skill), renderSkillMd(skill));
  }
  const writes = new Map<string, string>();
  const unchanged: string[] = [];
  for (const [dir, content] of desired) {
    if (existing.get(dir) === content) unchanged.push(dir);
    else writes.set(dir, content);
  }
  const prunes: string[] = [];
  for (const [dir, content] of existing) {
    if (!desired.has(dir) && content.includes(MANAGED_MARKER)) prunes.push(dir);
  }
  return { writes, unchanged, prunes: prunes.sort() };
}
