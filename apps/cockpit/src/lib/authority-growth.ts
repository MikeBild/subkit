// What a version reaches beyond the approval it did not take over, in one
// line. The engine reports the growth (`boundary_growth` on the review,
// `approval.growth` on the attention item); this only words it.

import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type BoundaryGrowth = components["schemas"]["AuthorityBoundaryGrowth"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

function keyOf(entry: BoundaryGrowth): TranslationKey {
  switch (entry.kind) {
    case "new_connector":
      return "authority.growth.newConnector";
    case "new_target":
      return "authority.growth.newTarget";
    case "changed_boundary":
      return "authority.growth.changed";
    case "wider_effect":
      return entry.effect === "destructive"
        ? "authority.growth.deletes"
        : entry.effect === "unknown"
          ? "authority.growth.unknown"
          : "authority.growth.writes";
  }
}

/** One line naming the first thing that is new, and how many more there are.
 *  Null when nothing grew. */
export function growthLine(t: Translate, growth: readonly BoundaryGrowth[] | undefined) {
  const first = growth?.[0];
  if (!first || !growth) return null;
  const name = first.connector_name ?? first.target ?? first.connector_id ?? "";
  const line = t(keyOf(first), { name, target: first.target ?? name });
  return growth.length > 1 ? t("authority.growth.more", { line, count: growth.length - 1 }) : line;
}
