import { IconTile } from "@ui/atoms/icon-tile";
import { SOURCE_TONE, type SourceView } from "@/features/knowledge/model/knowledge";
import { SOURCE_KIND_KEY, SOURCE_STATUS_KEY } from "@/features/knowledge/model/source-list-model";
import { humanizeCategory } from "@/features/workflows/model";
import { useI18n } from "@/lib/i18n-context";
import { plural } from "@/lib/plural";
import { categoryCounts } from "../list-model";
import {
  type ColumnChoice,
  GroupedTable,
  type Head,
  type ListState,
  ListSummary,
  NameCell,
  NoMatch,
  Row,
  StatusCell,
  Toolbar,
  useRel,
} from "../shell";
import { SOURCE_KIND_ICON } from "./source-kind-icon";

export function SourcesList({
  st,
  head,
  columns,
  views,
  items,
  groups,
  sections,
  loaded,
  onOpen,
}: {
  st: ListState;
  head: Head[];
  columns: ColumnChoice;
  views: SourceView[];
  items: SourceView[];
  groups: [string, SourceView[]][];
  sections: number;
  loaded?: { items: unknown[]; total: number; truncated?: boolean } | undefined;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const rel = useRel();
  const other = t("catalog.categoryOther");
  return (
    <>
      <Toolbar
        st={st}
        groups={["category", "status", "kind"]}
        categories={categoryCounts(views)}
        createdBy
        columns={columns}
      />
      <ListSummary
        testId="kn-sources-summary"
        kind="knowledge_source"
        loaded={loaded}
        parts={[
          plural(t, "kn.sources.count", items.length, {
            sections: plural(t, "kn.sources.sections", sections),
          }),
        ]}
      />
      {items.length ? (
        <GroupedTable
          head={head}
          hidden={columns.hidden}
          sort={st.sort}
          onSort={st.sortBy}
          groups={groups}
          row={(x) => (
            <Row key={x.id} onOpen={() => onOpen(x.id)} label={x.name}>
              <td>
                <NameCell
                  icon={<IconTile icon={SOURCE_KIND_ICON[x.kind]} size="sm" />}
                  title={x.name}
                  sub={x.url ?? humanizeCategory(x.category, other)}
                />
              </td>
              <td>
                <StatusCell tone={SOURCE_TONE[x.status]} label={t(SOURCE_STATUS_KEY[x.status])} />
              </td>
              <td>{t(SOURCE_KIND_KEY[x.kind])}</td>
              <td className="whitespace-nowrap">
                {x.status === "ingesting" ? "—" : plural(t, "kn.sources.sections", x.sections)}
              </td>
              <td className="whitespace-nowrap text-muted-foreground">{rel(x.ingested)}</td>
            </Row>
          )}
        />
      ) : views.length ? (
        <NoMatch onReset={st.reset} />
      ) : null}
    </>
  );
}
