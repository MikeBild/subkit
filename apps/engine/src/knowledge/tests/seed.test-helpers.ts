import type { SeedSource } from "../seed.ts";

export function validKnowledgeMd(opts: {
  slug: string;
  name?: string;
  description?: string;
  tags?: string[];
  scope?: string;
  body?: string;
  version?: number;
}): string {
  const tagsLine = opts.tags ? `tags: [${opts.tags.join(", ")}]` : "tags: []";
  return [
    "---",
    `slug: ${opts.slug}`,
    `name: ${opts.name ?? "Test Knowledge Source"}`,
    `description: ${opts.description ?? "A test knowledge source."}`,
    tagsLine,
    `scope: ${opts.scope ?? "global"}`,
    `version: ${opts.version ?? 1}`,
    "---",
    "",
    opts.body ?? "# Body\n\nSomething useful here.",
  ].join("\n");
}

export function src(name: string, content: string): SeedSource {
  return { file: `${name}.md`, content };
}

export const NEW_SKILL_SLUGS = [
  "webhooks-and-triggers",
  "engine-rest-api",
  "engine-status-and-capabilities",
  "external-chat-integration",
  "sk-cli-reference",
] as const;
