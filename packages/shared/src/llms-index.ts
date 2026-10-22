import { z } from "zod";

export interface LlmsPage {
  path: string;
  title: string;
  summary: string;
}

export const LLMS_PAGE_PATHS: ReadonlyArray<string> = [
  "setup.md",
  "coding-agents.md",
  "cli.md",
  "settings.md",
  "connectors.md",
  "transactional-email.md",
];

export interface RenderLlmsIndexOptions {
  linkFor: (page: LlmsPage) => string;
  fullUrl: string;
}

export function renderLlmsIndex(pages: LlmsPage[], opts: RenderLlmsIndexOptions): string {
  const lines = [
    "# SubKit",
    "",
    "> A self-hosted engine for governed workflows. These pages describe setup, coding-agent briefings and hooks, the sk CLI, runtime settings, the connector catalog, and governed transactional email.",
    `> All pages in one file: ${opts.fullUrl}`,
    "",
    "## Pages",
    "",
  ];
  for (const page of pages) {
    const summary = page.summary ? `: ${page.summary}` : "";
    lines.push(`- [${page.title}](${opts.linkFor(page)})${summary}`);
  }
  return lines.join("\n");
}

export const DOCS_SECTION_IDS = ["start", "work", "operate", "reference"] as const;

export type DocsSectionId = (typeof DOCS_SECTION_IDS)[number];

export interface DocsSectionText {
  title: string;
  description: string;
}

export interface DocsSection {
  id: DocsSectionId;
  locales: { en: DocsSectionText; de: DocsSectionText };
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    id: "start",
    locales: {
      en: {
        title: "Getting started",
        description:
          "Learn what SubKit is, get an engine running and build your first workflow, in this order.",
      },
      de: {
        title: "Erste Schritte",
        description:
          "Lerne, was SubKit ist, bring eine Engine zum Laufen und baue deinen ersten Workflow, in dieser Reihenfolge.",
      },
    },
  },
  {
    id: "work",
    locales: {
      en: {
        title: "Working with SubKit",
        description:
          "Reach SubKit from your terminal, an AI client, a coding agent, the browser, the HTTP API or your own app.",
      },
      de: {
        title: "Mit SubKit arbeiten",
        description:
          "Erreiche SubKit aus deinem Terminal, einem KI-Client, einem Coding-Agenten, dem Browser, der HTTP-API oder deiner eigenen App.",
      },
    },
  },
  {
    id: "operate",
    locales: {
      en: {
        title: "Operating SubKit",
        description:
          "Run your own engine: branding, sessions, identities, permissions, credentials and sandbox limits.",
      },
      de: {
        title: "Selbst betreiben",
        description:
          "Betreibe deine eigene Engine: Branding, Sitzungen, Identitäten, Berechtigungen, Zugangsdaten und Sandbox-Grenzen.",
      },
    },
  },
  {
    id: "reference",
    locales: {
      en: {
        title: "Reference",
        description: "Look up commands, settings, connectors and the license.",
      },
      de: {
        title: "Referenz",
        description: "Schlag Befehle, Einstellungen, Konnektoren und die Lizenz nach.",
      },
    },
  },
];

export function docsSectionRank(section: DocsSectionId): number {
  return DOCS_SECTION_IDS.indexOf(section);
}

const DocsSectionTextSchema = z.object({ title: z.string(), description: z.string() });

const DocsLocaleContentSchema = z.object({
  title: z.string(),
  summary: z.string(),
  headings: z.array(z.object({ depth: z.number().int(), text: z.string(), anchor: z.string() })),
  images: z.array(
    z.object({
      src: z.string(),
      alt: z.string(),
      build: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
  ),
  sha256: z.string(),
  body: z.string(),
});

export const DocsBundleSchema = z.object({
  locales: z.tuple([z.literal("en"), z.literal("de")]),
  sections: z.array(
    z.object({
      id: z.enum(DOCS_SECTION_IDS),
      locales: z.object({ en: DocsSectionTextSchema, de: DocsSectionTextSchema }),
    }),
  ),
  pages: z.array(
    z.object({
      slug: z.string(),
      llms_path: z.string().nullable(),
      audience: z.enum(["public", "operator"]),
      section: z.enum(DOCS_SECTION_IDS),
      order: z.number().int(),
      generated: z.boolean(),
      path_choice: z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .optional(),
      locales: z.object({ en: DocsLocaleContentSchema, de: DocsLocaleContentSchema }),
    }),
  ),
});

export type DocsBundle = z.infer<typeof DocsBundleSchema>;
