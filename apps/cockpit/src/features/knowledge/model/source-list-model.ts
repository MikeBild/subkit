import { type CreatedBy, createdByMatches, type SortOrder, sortRows } from "../list-model";
import { matches, type SourceKindView, type SourceStatus, type SourceView } from "./knowledge";

export const SOURCE_KIND_KEY = {
  url: "kn.sources.kind.url",
  file: "kn.sources.kind.file",
  text: "kn.sources.kind.text",
  collection: "kn.sources.kind.collection",
  api: "kn.sources.kind.api",
} as const satisfies Record<SourceKindView, string>;

export const SOURCE_STATUS_KEY = {
  active: "kn.status.active",
  ingesting: "kn.sources.status.ingesting",
  failed: "kn.sources.status.failed",
  off: "kn.status.off",
} as const satisfies Record<SourceStatus, string>;

export const SOURCE_PROMPTS = [
  "kn.sources.prompt.stale",
  "kn.sources.prompt.ask",
  "kn.sources.prompt.summarize",
] as const;

export const SOURCE_STARTERS = ["handbook", "product", "faq", "api", "prices"] as const;

const SOURCE_SORT: Record<string, (x: SourceView) => string | number> = {
  name: (x) => x.name,
  status: (x) => x.status,
  kind: (x) => x.kind,
  sections: (x) => x.sections,
  ingested: (x) => x.ingested,
};

export interface SourceFilter {
  category: string;
  createdBy: CreatedBy;
  q: string;
  sort: { key: string; order: SortOrder };
}

export function visibleSources(
  views: readonly SourceView[],
  filter: SourceFilter,
  kindLabel: (kind: SourceKindView) => string,
): SourceView[] {
  return sortRows(
    views.filter(
      (x) =>
        (filter.category === "all" || x.category === filter.category) &&
        createdByMatches(x.describedBy, filter.createdBy) &&
        matches(filter.q, x.name, x.url, kindLabel(x.kind), x.category),
    ),
    SOURCE_SORT[filter.sort.key] ?? null,
    filter.sort.order,
  );
}

export interface SourceGroupLabels {
  category: (category: string) => string;
  status: (status: SourceStatus) => string;
  kind: (kind: SourceKindView) => string;
}

export function sourceGroupKey(
  group: string,
  labels: SourceGroupLabels,
): ((x: SourceView) => string) | null {
  if (group === "category") return (x) => labels.category(x.category);
  if (group === "status") return (x) => labels.status(x.status);
  if (group === "kind") return (x) => labels.kind(x.kind);
  return null;
}

export function sectionTotal(items: readonly SourceView[]): number {
  return items.reduce((n, x) => n + x.sections, 0);
}
