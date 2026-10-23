import {
  ChipFilter,
  type ChipFilterOption,
  GroupAttentionBadge,
  type TableGrouping,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";
import type { CategoryCount } from "./catalog-metadata";

export const CATEGORY_GROUP = "category";

export function compareCategoryKeys(left: string, right: string): number {
  return (
    Number(left === UNCATEGORIZED) - Number(right === UNCATEGORIZED) || left.localeCompare(right)
  );
}

export function categoryCounts(usage: readonly CategoryCount[]): ReadonlyMap<string, number> {
  return new Map(usage.map((entry) => [entry.category, entry.count]));
}

export function catalogCategoryGrouping<T>({
  getCategory,
  otherLabel,
  counts,
  needsAttention,
}: {
  getCategory(row: T): string;
  otherLabel: string;
  counts?: ReadonlyMap<string, number>;
  needsAttention?(row: T): boolean;
}): TableGrouping<T> {
  return {
    getKey: getCategory,
    label: (key) => humanizeCategory(key, otherLabel),
    compareKeys: compareCategoryKeys,
    ...(counts ? { count: (key: string) => counts.get(key) } : {}),
    ...(needsAttention
      ? {
          rankWithin: (row: T) => (needsAttention(row) ? 0 : 1),
          badge: (_key: string, rows: readonly T[]) => (
            <GroupAttentionBadge count={rows.filter(needsAttention).length} />
          ),
        }
      : {}),
    collapseScope: CATEGORY_GROUP,
  };
}

export function categoryChipOptions(
  usage: readonly CategoryCount[],
  otherLabel: string,
): ChipFilterOption[] {
  return [...usage]
    .sort(
      (left, right) =>
        right.count - left.count || compareCategoryKeys(left.category, right.category),
    )
    .map((entry) => ({
      value: entry.category,
      label: humanizeCategory(entry.category, otherLabel),
      count: entry.count,
    }));
}

export function CatalogCategoryChips({
  usage,
  value,
  onChange,
  testId = "catalog-category-chips",
}: {
  usage: readonly CategoryCount[];
  value: string;
  onChange(value: string): void;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <ChipFilter
      label={t("catalog.block")}
      allLabel={t("common.all")}
      value={value}
      onChange={onChange}
      options={categoryChipOptions(usage, t("catalog.categoryOther"))}
      testId={testId}
    />
  );
}
