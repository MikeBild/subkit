import { useQuery } from "@tanstack/react-query";
import { Download, Package, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { listPackageInstalls, type PackageInstall } from "@/api/packages";
import { useSession } from "@/app/session";
import { PackageExportDialog, PackageImportDialog } from "@/components/cockpit/package-dialogs";
import { Button, type CockpitColumn, SectionHeading } from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import {
  ACTION_LABEL,
  installSource,
  packagePermissions,
  summaryEntries,
} from "./settings-packages-model";

const INSTALLS_KEY = ["packages", "installs"] as const;

const REVEAL_SETTLE_MS = 3000;

function revealWhenLinked(section: HTMLElement | null) {
  if (!section || window.location.hash !== "#packages") return;
  const observer = new ResizeObserver(() => section.scrollIntoView({ block: "start" }));
  observer.observe(section.parentElement ?? section);
  setTimeout(() => observer.disconnect(), REVEAL_SETTLE_MS);
}

export function PackagesSettings() {
  const { t } = useI18n();
  const session = useSession();
  const access = packagePermissions(session.permissions);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  if (!access.canExport && !access.canImport) return null;
  return (
    <section
      id="packages"
      ref={revealWhenLinked}
      className="grid scroll-mt-4 gap-3"
      data-testid="settings-packages"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <SectionHeading className="flex items-center gap-2 text-base font-semibold">
            <Package aria-hidden="true" className="size-4" />
            {t("settings.packages.title")}
          </SectionHeading>
          <p className="text-sm text-muted-foreground">{t("settings.packages.line")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {access.canExport ? (
            <Button
              variant="outline"
              onClick={() => setExporting(true)}
              data-testid="settings-packages-export-open"
            >
              <Download aria-hidden="true" />
              {t("packages.menu.export")}
            </Button>
          ) : null}
          {access.canImport ? (
            <Button
              variant="outline"
              onClick={() => setImporting(true)}
              data-testid="settings-packages-import-open"
            >
              <Upload aria-hidden="true" />
              {t("packages.menu.import")}
            </Button>
          ) : null}
        </div>
      </div>
      {access.canImport ? <PackageInstalls /> : null}
      {access.canExport ? (
        <PackageExportDialog open={exporting} onOpenChange={setExporting} />
      ) : null}
      {access.canImport ? (
        <PackageImportDialog open={importing} onOpenChange={setImporting} />
      ) : null}
    </section>
  );
}

function PackageInstalls() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: INSTALLS_KEY, queryFn: listPackageInstalls });
  return (
    <PackageInstallsTable
      installs={query.data?.items ?? []}
      pending={query.isPending}
      failed={Boolean(query.error) && !query.data}
      onRetry={() => void query.refetch()}
      title={t("settings.packages.installs.title")}
    />
  );
}

export function PackageInstallsTable({
  installs,
  pending,
  failed,
  onRetry,
  title,
}: {
  installs: PackageInstall[];
  pending: boolean;
  failed: boolean;
  onRetry(): void;
  title: string;
}) {
  const { t, dateTime } = useI18n();
  const columns = useMemo<CockpitColumn<PackageInstall>[]>(() => {
    const column = tableColumns<PackageInstall>({ t, dateTime });
    return [
      column.custom(
        "package",
        (row) => row.package_id,
        t("settings.packages.installs.column.package"),
        (row) => <span className="break-all font-mono text-xs">{row.package_id}</span>,
        { width: "w-[26%]" },
      ),
      column.custom(
        "version",
        (row) => row.package_version,
        t("settings.packages.installs.column.version"),
        (row) => <span className="font-mono text-xs">{row.package_version}</span>,
        { width: "w-[16%]", priority: "low" },
      ),
      column.custom(
        "source",
        (row) => installSource(row.source),
        t("settings.packages.installs.column.source"),
        (row) => installSource(row.source) ?? MISSING,
        { width: "w-[20%]", priority: "low" },
      ),
      column.date(
        "installed",
        (row) => row.created_at,
        t("settings.packages.installs.column.installed"),
        {
          width: "w-[16%]",
        },
      ),
      column.custom(
        "result",
        (row) => row.id,
        t("settings.packages.installs.column.result"),
        (row) => {
          const entries = summaryEntries(
            row.summary as Partial<Record<keyof typeof ACTION_LABEL, unknown>>,
          );
          return entries.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {entries
                .map(({ action, count }) => `${t(ACTION_LABEL[action])} ${count}`)
                .join(" · ")}
            </span>
          ) : (
            MISSING
          );
        },
        { width: "w-[22%]" },
      ),
    ];
  }, [t, dateTime]);
  return (
    <div className="grid gap-2" data-testid="settings-packages-installs">
      <span className="text-sm font-semibold">{title}</span>
      <RecordTable
        columns={columns}
        data={installs}
        collectionId="settings-packages-installs"
        emptyLine={t("settings.packages.installs.empty")}
        pending={pending}
        error={failed ? { line: t("settings.packages.installs.loadFailed"), onRetry } : null}
        getRowId={(row) => row.id}
        rowLabel={(row) => row.package_id}
      />
    </div>
  );
}
