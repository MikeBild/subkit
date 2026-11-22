import { useMemo } from "react";
import { groupBy, type SourceView, sourceView } from "@/features/knowledge/model/knowledge";
import {
  SOURCE_KIND_KEY,
  SOURCE_STATUS_KEY,
  sectionTotal,
  sourceGroupKey,
  visibleSources,
} from "@/features/knowledge/model/source-list-model";
import { humanizeCategory } from "@/features/workflows/model";
import { useI18n } from "@/lib/i18n-context";
import { useSources } from "../queries";
import type { ListState } from "../shell";

export function useSourceList(st: ListState) {
  const { t } = useI18n();
  const query = useSources();
  const views = useMemo(() => (query.data?.items ?? []).map(sourceView), [query.data]);
  const other = t("catalog.categoryOther");
  const kindLabel = (kind: SourceView["kind"]) => t(SOURCE_KIND_KEY[kind]);
  const items = visibleSources(
    views,
    { category: st.cat, createdBy: st.createdBy, q: st.q, sort: st.sort },
    kindLabel,
  );
  const groups = groupBy(
    items,
    sourceGroupKey(st.group, {
      category: (category) => humanizeCategory(category, other),
      status: (status) => t(SOURCE_STATUS_KEY[status]),
      kind: kindLabel,
    }),
  );
  return { query, views, items, groups, sections: sectionTotal(items) };
}
