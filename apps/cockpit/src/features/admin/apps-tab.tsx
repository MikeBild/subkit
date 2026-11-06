import { useState } from "react";
import { type CockpitColumn, RowName } from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { type AppSummary, appFailingSummary, appReadiness } from "@/pages/apps-model";
import { AppSheet, ReadinessBadge } from "./app-sheet";
import { environmentLabel, useApps } from "./apps-data";
import { AdminTable, SectionList } from "./parts";

export function AppsTab() {
  const { t, tn, dateTime } = useI18n();
  const query = useApps();
  const items = query.data?.items ?? [];
  const [openedId, setOpenedId] = useState<string | null>(null);
  const columns: CockpitColumn<AppSummary>[] = (() => {
    const column = tableColumns<AppSummary>({ t, dateTime });
    return [
      column.custom(
        "id",
        (row) => row.id,
        t("apps.column.app"),
        (app, index) => (
          <span className="block truncate" data-testid={`apps-list-${index}-name`}>
            <RowName>{app.id}</RowName>
          </span>
        ),
        { width: "w-[30%]", ownsRowLink: true },
      ),
      column.custom(
        "environment",
        (row) => row.settings?.execution_environment,
        t("apps.column.environment"),
        (row) => (row.settings ? environmentLabel(row.settings.execution_environment, t) : MISSING),
        { width: "w-[20%]" },
      ),
      column.custom(
        "users",
        (row) => row.users.count,
        t("apps.column.users"),
        (row) => row.users.count,
        { width: "w-[20%]" },
      ),
      column.custom(
        "readiness",
        (row) => appReadiness(row),
        t("apps.column.readiness"),
        (row, index) => (
          <span title={appFailingSummary(row.failing_checks, t) || undefined}>
            <ReadinessBadge app={row} testId={`apps-list-${index}-readiness`} />
          </span>
        ),
        { width: "w-[30%]" },
      ),
    ];
  })();
  return (
    <div data-testid="apps-section">
      <SectionList
        name="apps"
        help={t("apps.help")}
        resource={t("people.section.apps")}
        query={query}
        emptyLine={t("apps.empty")}
        summary={tn("apps.summary", items.length)}
      >
        <AdminTable
          collectionId="apps-list"
          columns={columns}
          data={items}
          onOpen={(row) => setOpenedId(row.id)}
          rowLabel={(row) => t("apps.openRow", { id: row.id })}
        />
      </SectionList>
      <AppSheet appId={openedId} onClose={() => setOpenedId(null)} />
    </div>
  );
}
