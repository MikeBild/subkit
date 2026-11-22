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
    "> A self-hosted engine for governed workflows. These pages describe setup, coding-agent briefings and hooks, the subkit CLI, runtime settings, the connector catalog, and governed transactional email.",
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
          "Get to know SubKit, choose the cloud or your own engine, set it up and build your first workflow, in this order.",
      },
      de: {
        title: "Erste Schritte",
        description:
          "Lerne SubKit kennen, wähle Cloud oder eigene Engine, richte sie ein und baue deinen ersten Workflow, in dieser Reihenfolge.",
      },
    },
  },
  {
    id: "work",
    locales: {
      en: {
        title: "Working with SubKit",
        description:
          "Use SubKit from the terminal, an AI client, a coding agent, the browser or your own app, and keep knowledge and costs in view.",
      },
      de: {
        title: "Mit SubKit arbeiten",
        description:
          "Arbeite mit SubKit im Terminal, aus einem KI-Client, einem Coding-Agenten, dem Browser oder deiner App, und behalte Wissen und Kosten im Blick.",
      },
    },
  },
  {
    id: "operate",
    locales: {
      en: {
        title: "Operating SubKit",
        description:
          "Run your own engine: decide who may do what, how apps and connectors sign in, how the Cockpit looks and where the sandbox ends.",
      },
      de: {
        title: "Selbst betreiben",
        description:
          "Betreibe deine eigene Engine: Lege fest, wer was darf, wie sich Apps und Konnektoren anmelden, wie das Cockpit aussieht und wo die Sandbox endet.",
      },
    },
  },
  {
    id: "reference",
    locales: {
      en: {
        title: "Reference",
        description: "Look up subkit commands, settings, the connector catalog and the license.",
      },
      de: {
        title: "Referenz",
        description:
          "Schlag subkit-Befehle, Einstellungen, den Konnektor-Katalog und die Lizenz nach.",
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
