import type { components } from "@cli-core/engine-api/openapi";
import type { Translate, TranslationKey } from "@/lib/i18n";

export type BoundaryGrowth = components["schemas"]["AuthorityBoundaryGrowth"];

function keyOf(entry: BoundaryGrowth): TranslationKey {
  switch (entry.kind) {
    case "new_connector":
      return "authority.growth.newConnector";
    case "new_target":
      return "authority.growth.newTarget";
    case "changed_boundary":
      return "authority.growth.changed";
    case "new_device":
      return "authority.growth.newDevice";
    case "new_folder":
      return "authority.growth.newFolder";
    case "wider_folder_access":
      return "authority.growth.folderWrites";
    case "new_site":
      return "authority.growth.newSite";
    case "private_site":
      return "authority.growth.privateSite";
    case "new_app":
      return "authority.growth.newApp";
    case "new_secret":
      return "authority.growth.newSecret";
    case "wider_effect":
      return entry.effect === "destructive"
        ? "authority.growth.deletes"
        : entry.effect === "unknown"
          ? "authority.growth.unknown"
          : "authority.growth.writes";
  }
}

export function growthLine(t: Translate, growth: readonly BoundaryGrowth[] | undefined) {
  const first = growth?.[0];
  if (!first || !growth) return null;
  const name = first.item ?? first.connector_name ?? first.target ?? first.connector_id ?? "";
  const line = t(keyOf(first), { name, target: first.target ?? name });
  return growth.length > 1 ? t("authority.growth.more", { line, count: growth.length - 1 }) : line;
}
