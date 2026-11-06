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

interface SyncPlan {
  writes: Map<string, string>;
  unchanged: string[];
  prunes: string[];
}

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
