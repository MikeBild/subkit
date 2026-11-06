import type { ReplyLanguage } from "../fast-path-lists.ts";

export type CatalogKind =
  | "workflows"
  | "connectors"
  | "executions"
  | "schedules"
  | "knowledge_sources";

const LIST_RES: Record<CatalogKind, readonly RegExp[]> = {
  workflows: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:saved\s+|gespeicherte[nr]?\s+)?workflows?\s*\??$/i,
  ],
  connectors: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?connectors?\s*\??$/i,
  ],
  executions: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:die\s+|recent\s+|letzte[nr]?\s+|my\s+|meine\s+)?executions?\s*\??$/i,
  ],
  schedules: [
    /^(?:list|show|display|zeige|welche|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:active\s+|aktive[nr]?\s+)?schedules?\s*\??$/i,
  ],
  knowledge_sources: [
    /^(?:list|show|display|zeige|welche|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:knowledge[\s-]?sources?|wissensquellen)\s*\??$/i,
  ],
};

export function matchListIntent(text: string): CatalogKind | null {
  for (const kind of Object.keys(LIST_RES) as CatalogKind[]) {
    if (LIST_RES[kind].some((re) => re.test(text))) return kind;
  }
  return null;
}

const CATALOG_NOUN_RES: Array<[CatalogKind, RegExp]> = [
  ["workflows", /\bworkflows?\b/i],
  ["connectors", /\bconnectors?\b/i],
  ["executions", /\b(?:executions?|runs?)\b/i],
  ["schedules", /\bschedules?\b/i],
  ["knowledge_sources", /\b(?:knowledge[\s-]?sources?|knowledges?|wissensquellen)\b/i],
];

const MULTI_CATALOG_RE =
  /^(?:list|show|display|view|get|zeige|liste|welche)\s+(?:my|all|the|our|meine|alle|unsere|and|und|sowie|plus|also|,|&|\+|\s|workflows?|connectors?|executions?|runs?|schedules?|knowledge[\s-]?sources?|knowledges?|wissensquellen)+\s*\??$/i;

export function matchMultiCatalog(text: string): CatalogKind[] | null {
  if (!MULTI_CATALOG_RE.test(text)) return null;
  const kinds: CatalogKind[] = [];
  for (const [kind, re] of CATALOG_NOUN_RES) {
    if (re.test(text) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length >= 2 ? kinds : null;
}

const CATEGORY_TOKEN = String.raw`(?:@(?:kategorie|category)\/)?([a-z0-9][a-z0-9_-]*?)`;
const WHAT_THEY_DO = String.raw`(?:\s*,?\s+(?:und\s+was\s+sie\s+tun|and\s+what\s+they\s+do))?`;
const END = String.raw`\s*[?.!]?$`;
const CATEGORY_LIST_RES = [
  new RegExp(
    String.raw`^(?:zeige?|show|list)\s+(?:mir\s+|me\s+)?(?:die\s+|alle\s+|the\s+|all\s+)?${CATEGORY_TOKEN}[-\s]workflows?${WHAT_THEY_DO}${END}`,
    "i",
  ),
  new RegExp(
    String.raw`^(?:(?:zeige?|show|list)\s+(?:mir\s+|me\s+)?)?(?:die\s+|alle\s+|the\s+|all\s+)?workflows?\s+(?:in|aus)\s+(?:der\s+kategorie\s+|the\s+category\s+|category\s+)?${CATEGORY_TOKEN}${WHAT_THEY_DO}${END}`,
    "i",
  ),
];

const GERMAN_CATEGORY_LIST_RE =
  /(?:^|\s)(?:zeige?|mir|die|alle|aus|der\s+kategorie|und\s+was\s+sie\s+tun)(?=\s|$)|@kategorie\//i;

export function categoryListLanguage(text: string): ReplyLanguage {
  return GERMAN_CATEGORY_LIST_RE.test(text) ? "de" : "en";
}

export function matchCategoryListIntent(text: string): string | null {
  for (const re of CATEGORY_LIST_RES) {
    const m = text.match(re);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}
