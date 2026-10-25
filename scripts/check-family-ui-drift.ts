import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAVIGATION } from "../apps/cockpit/src/app/navigation.ts";
import { CATALOGS, type TranslationKey } from "../apps/cockpit/src/lib/i18n.ts";

type Json = Record<string, unknown>;

const root = join(import.meta.dir, "..");

const TEXT_SIZE_PX: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
};
const FONT_WEIGHT: Record<string, number> = { normal: 400, medium: 500, semibold: 600, bold: 700 };

const NAV_LABEL_KEYS: Record<string, TranslationKey> = {
  attention: "nav.overview",
  chat: "nav.chat",
  workflows: "nav.workflows",
  connectors: "nav.connectors",
  inbox: "nav.inbox",
  knowledgeSources: "nav.knowledgeSources",
  skills: "nav.skills",
  files: "nav.files",
  usage: "nav.usage",
  audit: "nav.audit",
  people: "nav.people",
  credentials: "nav.apiAccess",
  settings: "nav.settings",
  automation: "nav.group.automation",
  knowledge: "nav.group.knowledge",
  installation: "nav.group.admin",
};

const GROUP_FOR_ID: Record<string, string | null> = {
  home: null,
  build: "automation",
  knowledge: "knowledge",
  admin: "installation",
};

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function capture(
  source: string,
  pattern: RegExp,
  what: string,
  problems: string[],
): string[] | null {
  const match = pattern.exec(source);
  if (!match) {
    problems.push(`code anchor not found: ${what}`);
    return null;
  }
  return match.slice(1);
}

function typographyOf(classNames: string): string | null {
  const size = /\btext-(xs|sm|base|lg|xl|2xl)\b/.exec(classNames)?.[1];
  const leading = /\bleading-(\d+)\b/.exec(classNames)?.[1];
  const weight = /\bfont-(normal|medium|semibold|bold)\b/.exec(classNames)?.[1];
  if (!size || !leading) return null;
  return `${TEXT_SIZE_PX[size]}px/${Number(leading) * 4}px ${weight ? FONT_WEIGHT[weight] : 400}`;
}

export function collectCodeValues(problems: string[]) {
  const shell = read("apps/cockpit/src/app/shell.tsx");
  const family = read("apps/cockpit/src/components/family-ui.tsx");
  const sidebar = read("apps/cockpit/src/components/ui/sidebar.tsx");
  const tabs = read("apps/cockpit/src/components/cockpit/patterns/grouping-tabs.tsx");
  const button = read("apps/cockpit/src/components/ui/button.tsx");
  const card = read("apps/cockpit/src/components/ui/card.tsx");
  const table = read("apps/cockpit/src/components/ui/table.tsx");
  const css = read("apps/cockpit/src/index.css");
  const message = read("apps/cockpit/src/components/ai-elements/message.tsx");

  const header = capture(
    shell,
    /className="flex h-(\d+) shrink-0 items-center gap-3 border-b/,
    "shell header height",
    problems,
  );
  const measure = (name: string) => {
    const found = capture(
      family,
      new RegExp(`${name}: "max-w-\\[(\\d+)px\\]"`),
      `family measure ${name}`,
      problems,
    );
    return found ? Number(found[0]) : null;
  };
  const sidebarWidth = capture(
    sidebar,
    /SIDEBAR_WIDTH = "(\d+(?:\.\d+)?)rem"/,
    "sidebar width",
    problems,
  );
  const sidebarIcon = capture(
    sidebar,
    /SIDEBAR_WIDTH_ICON = "(\d+(?:\.\d+)?)rem"/,
    "sidebar icon width",
    problems,
  );
  const gutter = capture(
    family,
    /gap-(\d+) px-(\d+) py-\d+ sm:px-(\d+)"/,
    "family page gap and gutters",
    problems,
  );
  const tab = capture(
    tabs,
    /"relative inline-flex h-(\d+) shrink-0 items-center/,
    "tab height",
    problems,
  );
  const control = capture(button, /default:\s*"h-(\d+) /, "default control height", problems);
  const cardSpacing = capture(
    card,
    /\[--card-spacing:--spacing\((\d+)\)\]/,
    "card spacing",
    problems,
  );
  const cardRadius = capture(card, /overflow-hidden rounded-(xl) /, "card radius", problems);
  const radius = capture(css, /--radius: (\d+(?:\.\d+)?)px;/, "base radius", problems);
  const radiusXl = capture(
    css,
    /--radius-xl: calc\(var\(--radius\) \* (\d+(?:\.\d+)?)\)/,
    "xl radius factor",
    problems,
  );
  const rowMin = capture(
    table,
    /"h-(\d+) border-b transition-colors hover:bg-muted\/50/,
    "table row height",
    problems,
  );
  const title = capture(family, /<h1 className="([^"]+)">/, "page title", problems);
  const section = capture(family, /<h2 className="([^"]+)">\{title\}/, "section title", problems);
  const body = capture(
    family,
    /<p className="mt-1 max-w-3xl ([^"]+)">\{description\}/,
    "page description",
    problems,
  );
  const meta = capture(
    family,
    /<div className="mb-2 ([^"]+)">\{context\}/,
    "page context",
    problems,
  );
  const article = capture(
    message,
    /"\[&_p\]:break-words \[&_p\]:leading-(\d+) \[&_li\]:break-words/,
    "article paragraph leading",
    problems,
  );

  const px = (value: string[] | null, factor = 4) => (value ? Number(value[0]) * factor : null);

  return {
    geometry: {
      sidebarExpandedPx: px(sidebarWidth, 16),
      sidebarCollapsedPx: px(sidebarIcon, 16),
      headerPx: px(header),
      gutterDesktopPx: gutter ? Number(gutter[2]) * 4 : null,
      gutterMobilePx: gutter ? Number(gutter[1]) * 4 : null,
      readingColumnPx: measure("reading"),
      workingColumnPx: measure("working"),
      workbenchColumnPx: measure("workbench"),
      cardRadiusPx:
        radius && radiusXl && cardRadius
          ? Math.round(Number(radius[0]) * Number(radiusXl[0]) * 100) / 100
          : null,
      cardGapPx: px(cardSpacing),
      sectionGapPx: gutter ? Number(gutter[0]) * 4 : null,
      controlHeightPx: px(control),
      tabHeightPx: px(tab),
      tableRowMinPx: px(rowMin),
    } as Record<string, number | null>,
    typography: {
      pageTitle: title ? typographyOf(title[0] as string) : null,
      sectionTitle: section ? typographyOf(section[0] as string) : null,
      body: body ? typographyOf(body[0] as string) : null,
      meta: meta ? typographyOf(meta[0] as string) : null,
      articleBody: article ? `14px/${Number(article[0]) * 4}px 400` : null,
    } as Record<string, string | null>,
  };
}

function compareScalars(
  scope: string,
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown>,
  problems: string[],
) {
  for (const [key, value] of Object.entries(actual)) {
    if (value === null) continue;
    const declared = expected?.[key];
    if (declared !== value) {
      problems.push(
        `${scope}.${key}: FAMILY-UI.json says ${JSON.stringify(declared)}, cockpit code says ${JSON.stringify(value)}`,
      );
    }
  }
  for (const key of Object.keys(expected ?? {})) {
    if (!(key in actual)) {
      problems.push(`${scope}.${key}: declared in FAMILY-UI.json but not checked against code`);
    }
  }
}

function compareNavigation(spec: Json, problems: string[]) {
  const navigation = spec.navigation as Json | undefined;
  const ungrouped: string[] = [];
  const groups: string[] = [];
  const groupItems: Record<string, string[]> = {};
  for (const group of NAVIGATION) {
    const name = GROUP_FOR_ID[group.id];
    const paths = group.items.map((item) => item.path);
    if (name === null || name === undefined) {
      ungrouped.push(...paths);
      continue;
    }
    groups.push(name);
    groupItems[name] = paths;
    if (group.labelKey !== NAV_LABEL_KEYS[name]) {
      problems.push(
        `navigation group ${group.id} uses ${group.labelKey}, expected ${NAV_LABEL_KEYS[name]}`,
      );
    }
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const expectations: Array<[string, unknown, unknown]> = [
    ["groups", navigation?.groups, groups],
    ["ungroupedItems", navigation?.ungroupedItems, ungrouped],
    ["groupItems", navigation?.groupItems, groupItems],
  ];
  for (const [key, declared, code] of expectations) {
    if (!same(declared, code)) {
      problems.push(
        `navigation.${key}: FAMILY-UI.json says ${JSON.stringify(declared)}, cockpit code says ${JSON.stringify(code)}`,
      );
    }
  }
  const labels = navigation?.labels as Record<string, Record<string, string>> | undefined;
  for (const locale of ["de", "en"] as const) {
    for (const [key, i18nKey] of Object.entries(NAV_LABEL_KEYS)) {
      const code = CATALOGS[locale][i18nKey];
      const declared = labels?.[locale]?.[key];
      if (declared !== code) {
        problems.push(
          `navigation.labels.${locale}.${key}: FAMILY-UI.json says ${JSON.stringify(declared)}, cockpit code says ${JSON.stringify(code)}`,
        );
      }
    }
  }
  if (!same(navigation?.firstItems, ["attention"]) || ungrouped[0] !== "/") {
    problems.push(
      'navigation.firstItems must be ["attention"] and the overview must lead the ungrouped items',
    );
  }
}

function compareDocuments(spec: Json, problems: string[], documents: Record<string, string>) {
  const geometry = spec.geometry as Record<string, number>;
  const navigation = spec.navigation as { labels: Record<string, Record<string, string>> };
  const konvention = documents["COCKPIT-KONVENTION.md"];
  if (konvention !== undefined) {
    for (const key of ["workbenchColumnPx", "workingColumnPx", "readingColumnPx", "headerPx"]) {
      if (!konvention.includes(`${geometry[key]}px`)) {
        problems.push(`COCKPIT-KONVENTION.md does not state ${geometry[key]}px (${key})`);
      }
    }
    for (const locale of ["de", "en"] as const) {
      const label = navigation.labels[locale].installation as string;
      if (!konvention.includes(`**„${label}"**`) && !konvention.includes(`**${label}**`)) {
        problems.push(
          `COCKPIT-KONVENTION.md does not name the admin group ${JSON.stringify(label)}`,
        );
      }
    }
    if (/Gruppe \*\*Installation\*\*|Admin-Gruppe heißt in beiden Sprachen/.test(konvention)) {
      problems.push("COCKPIT-KONVENTION.md still names the admin group Installation");
    }
  }
  const designSystem = documents[".superdesign/design-system.md"];
  if (designSystem !== undefined) {
    for (const [label, value] of [
      ["wide column max", geometry.workbenchColumnPx],
      ["working column max", geometry.workingColumnPx],
      ["header", geometry.headerPx],
    ] as const) {
      if (!designSystem.includes(`${label} ${value}px`)) {
        problems.push(`.superdesign/design-system.md does not state ${label} ${value}px`);
      }
    }
  }
}

function readDocuments(): Record<string, string> {
  const documents: Record<string, string> = {
    "COCKPIT-KONVENTION.md": read("COCKPIT-KONVENTION.md"),
  };
  if (existsSync(join(root, ".superdesign/design-system.md"))) {
    documents[".superdesign/design-system.md"] = read(".superdesign/design-system.md");
  }
  return documents;
}

export function collectFamilyUiDrift(
  spec: Json = JSON.parse(read("FAMILY-UI.json")) as Json,
  documents: Record<string, string> = readDocuments(),
): string[] {
  const problems: string[] = [];
  const code = collectCodeValues(problems);
  compareScalars("geometry", spec.geometry as Json, code.geometry, problems);
  compareScalars("typography", spec.typography as Json, code.typography, problems);
  compareNavigation(spec, problems);
  const radius = code.geometry.cardRadiusPx;
  const declaredRadius = (spec.visualLanguage as Json | undefined)?.radius;
  if (radius !== null && declaredRadius !== `${radius}px`) {
    problems.push(
      `visualLanguage.radius: FAMILY-UI.json says ${JSON.stringify(declaredRadius)}, cockpit code says "${radius}px"`,
    );
  }
  compareDocuments(spec, problems, documents);
  return problems;
}

if (import.meta.main) {
  const problems = collectFamilyUiDrift();
  if (problems.length > 0) {
    console.error("FAMILY-UI.json and the Cockpit code have drifted apart:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("FAMILY-UI.json matches the Cockpit code");
}
