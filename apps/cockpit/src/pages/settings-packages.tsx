import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleCheck,
  Clock,
  Download,
  FileArchive,
  Inbox,
  Info,
  KeyRound,
  Package,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  applyPackage,
  exportPackage,
  listPackageInstalls,
  PACKAGE_KINDS,
  type PackageApplyResult,
  type PackageExportResult,
  type PackageInstall,
  type PackageKind,
  type PackagePlanItem,
  type PackagePreviewResult,
  packageArchiveHref,
  previewPackageFile,
  previewStoredPackage,
} from "@/api/packages";
import { exportInstallationFile } from "@/app/installation-export";
import { absolute, routerTarget } from "@/app/links";
import { useSession } from "@/app/session";
import {
  Button,
  Chip,
  type CockpitColumn,
  ConfirmDialog,
  FileDrop,
  SectionHeading,
  StatusBadge,
  WizardProgress,
} from "@/components/cockpit/patterns";
import { Alert, AlertDescription, Checkbox } from "@/components/cockpit/patterns/controls";
import { RecordTable } from "@/components/cockpit/record-table";
import { bytes, MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import {
  ACTION_LABEL,
  actionTone,
  canApplyPlan,
  failedItems,
  installSource,
  KIND_LABEL,
  KINDS_LABEL,
  nextSteps,
  packagePermissions,
  planFromConflict,
  planHint,
  REQUIREMENT_LABEL,
  requirementCounts,
  sortedPlanItems,
  summaryEntries,
} from "./settings-packages-model";

const PACKAGE_MAX_BYTES = 256 * 1024 * 1024;
const INSTALLS_KEY = ["packages", "installs"] as const;
const LINK_CLASS = "font-medium text-primary underline-offset-4 hover:underline";

const REQUIREMENT_ICON = {
  credential: KeyRound,
  approval: ShieldCheck,
  schedule_resume: Clock,
  knowledge_review: Inbox,
} as const;

export function PackagesSettings() {
  const { t } = useI18n();
  const session = useSession();
  const access = packagePermissions(session.permissions);
  if (!access.canExport && !access.canImport) return null;
  return (
    <section className="grid gap-3" data-testid="settings-packages">
      <div className="grid gap-1">
        <SectionHeading className="flex items-center gap-2 text-base font-semibold">
          <Package aria-hidden="true" className="size-4" />
          {t("settings.packages.title")}
        </SectionHeading>
        <p className="text-sm text-muted-foreground">{t("settings.packages.line")}</p>
      </div>
      {access.canExport ? <PackageExportCard /> : null}
      {access.canImport ? (
        <>
          <PackageImportCard />
          <PackageInstalls />
        </>
      ) : null}
    </section>
  );
}

function PackageCard({
  icon,
  title,
  aside,
  testId,
  children,
}: {
  icon: ReactNode;
  title: string;
  aside?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4">
          {icon}
          {title}
        </span>
        {aside}
      </div>
      <div className="grid gap-4 p-4">{children}</div>
    </div>
  );
}

function PackageExportCard() {
  const { t } = useI18n();
  const [kinds, setKinds] = useState<ReadonlySet<PackageKind>>(() => new Set(PACKAGE_KINDS));
  const [downloading, setDownloading] = useState(false);
  const run = useMutation({
    mutationFn: () => exportPackage(PACKAGE_KINDS.filter((kind) => kinds.has(kind))),
    onError: () => toast.error(t("settings.packages.export.failed")),
  });
  const toggle = (kind: PackageKind, checked: boolean) => {
    setKinds((current) => {
      const next = new Set(current);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };
  const download = async (result: PackageExportResult) => {
    const href = packageArchiveHref(result.file_id);
    setDownloading(true);
    try {
      const saved = await exportInstallationFile(
        result.filename,
        async () => await fetch(href, { credentials: "same-origin" }),
      );
      if (saved === "unsupported") {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = result.filename;
        anchor.click();
      }
    } catch {
      toast.error(t("settings.packages.export.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <PackageCard
      icon={<Download aria-hidden="true" />}
      title={t("settings.packages.export.title")}
      aside={
        <span className="text-xs text-muted-foreground">
          {t("settings.packages.export.dependencies")}
        </span>
      }
      testId="settings-packages-export"
    >
      <fieldset className="grid gap-2">
        <legend className="sr-only">{t("settings.packages.export.kinds")}</legend>
        <div className="grid grid-cols-1 gap-2 text-sm @md:grid-cols-2 @3xl:grid-cols-4">
          {PACKAGE_KINDS.map((kind) => (
            <label
              key={kind}
              htmlFor={`settings-packages-kind-${kind}`}
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
            >
              <Checkbox
                id={`settings-packages-kind-${kind}`}
                checked={kinds.has(kind)}
                disabled={run.isPending}
                onCheckedChange={(checked) => toggle(kind, checked === true)}
                data-testid={`settings-packages-kind-${kind}`}
              />
              {t(KINDS_LABEL[kind])}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={kinds.size === 0}
          pending={run.isPending}
          onClick={() => run.mutate()}
          data-testid="settings-packages-export-run"
        >
          <Package aria-hidden="true" />
          {t("settings.packages.export.action")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("settings.packages.export.scope")}</span>
      </div>
      {run.data ? (
        <PackageExportResultView
          result={run.data}
          downloading={downloading}
          onDownload={() => void download(run.data)}
        />
      ) : null}
    </PackageCard>
  );
}

export function PackageExportResultView({
  result,
  downloading,
  onDownload,
}: {
  result: PackageExportResult;
  downloading: boolean;
  onDownload(): void;
}) {
  const { t, tn } = useI18n();
  const requirements = requirementCounts(result.requires);
  return (
    <div
      className="grid gap-3 rounded-lg border bg-muted/40 p-3"
      data-testid="settings-packages-export-result"
    >
      <div className="flex flex-wrap items-center gap-3">
        <CircleCheck aria-hidden="true" className="size-4 text-emerald-600" />
        <span className="break-all font-mono text-xs">{result.filename}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {bytes(result.size_bytes)}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          pending={downloading}
          onClick={onDownload}
          data-testid="settings-packages-export-download"
        >
          <Download aria-hidden="true" />
          {t("settings.packages.export.download")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PACKAGE_KINDS.filter((kind) => result.items_summary[kind] > 0).map((kind) => (
          <Chip key={kind} className="bg-background" testId={`settings-packages-export-${kind}`}>
            {t(KINDS_LABEL[kind])}
            <span className="tabular-nums text-muted-foreground">{result.items_summary[kind]}</span>
          </Chip>
        ))}
      </div>
      <div className="grid gap-1 text-sm" data-testid="settings-packages-export-requires">
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings.packages.export.requires")}
        </span>
        {requirements.length === 0 ? (
          <span className="text-muted-foreground">
            {t("settings.packages.export.requiresNone")}
          </span>
        ) : (
          requirements.map(({ kind, count }) => {
            const Icon = REQUIREMENT_ICON[kind];
            return (
              <span key={kind} className="flex items-center gap-2" data-requirement={kind}>
                <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                {tn(REQUIREMENT_LABEL[kind], count)}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

type ImportStage = { preview: PackagePreviewResult; changed: boolean } | null;

function PackageImportCard() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [stage, setStage] = useState<ImportStage>(null);
  const [result, setResult] = useState<PackageApplyResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const preview = useMutation({
    mutationFn: (source: File | string) =>
      typeof source === "string" ? previewStoredPackage(source) : previewPackageFile(source),
    onMutate: () => setFailure(null),
    onSuccess: (value) => setStage({ preview: value, changed: false }),
    onError: (error) =>
      setFailure(
        error instanceof ApiError && error.status === 413
          ? t("settings.packages.import.tooLarge")
          : t("settings.packages.import.previewFailed"),
      ),
  });
  const apply = useMutation({
    mutationFn: (value: PackagePreviewResult) =>
      applyPackage(value.archive_file_id, value.plan.plan_digest),
    onSuccess: (value) => {
      setConfirming(false);
      setStage(null);
      setResult(value);
      void client.invalidateQueries({ queryKey: INSTALLS_KEY });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      void client.invalidateQueries({ queryKey: ["intake"] });
    },
    onError: (error, value) => {
      setConfirming(false);
      if (error instanceof ApiError && error.status === 409) {
        const plan = planFromConflict(error.details);
        setStage({ preview: plan ? { ...value, plan } : value, changed: true });
        return;
      }
      toast.error(t("settings.packages.import.applyFailed"));
    },
  });
  const reset = () => {
    setStage(null);
    setResult(null);
    setFailure(null);
  };
  const step = result ? 2 : stage ? 1 : 0;
  return (
    <PackageCard
      icon={<Upload aria-hidden="true" />}
      title={t("settings.packages.import.title")}
      aside={
        <WizardProgress
          steps={[
            t("settings.packages.import.stepFile"),
            t("settings.packages.import.stepPreview"),
            t("settings.packages.import.stepResult"),
          ]}
          current={step}
          testId="settings-packages-import-step"
        />
      }
      testId="settings-packages-import"
    >
      {result ? (
        <PackageResultView result={result} onAnother={reset} />
      ) : stage ? (
        <PackagePreviewView
          preview={stage.preview}
          changed={stage.changed}
          refreshing={preview.isPending}
          applying={apply.isPending}
          onCancel={reset}
          onApply={() => setConfirming(true)}
          onRefresh={() => preview.mutate(stage.preview.archive_file_id)}
        />
      ) : (
        <FileDrop
          accept=".zip"
          maxBytes={PACKAGE_MAX_BYTES}
          disabled={preview.isPending}
          onFiles={(files) => {
            const file = files[0];
            if (file) preview.mutate(file);
          }}
          label={
            preview.isPending
              ? t("settings.packages.import.reading")
              : t("settings.packages.import.drop")
          }
          hint={t("settings.packages.import.dropHint")}
          testId="settings-packages-import-drop"
        />
      )}
      {failure && !result ? (
        <Alert variant="destructive" data-testid="settings-packages-import-error">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      {stage ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={(open) => !open && setConfirming(false)}
          object={t("settings.packages.import.object")}
          verb={t("settings.packages.import.verb")}
          consequence={t("settings.packages.import.consequence", {
            create: stage.preview.plan.summary.create,
            update: stage.preview.plan.summary.update,
          })}
          pending={apply.isPending}
          onConfirm={() => apply.mutate(stage.preview)}
          testId="settings-packages-import-confirm"
        />
      ) : null}
    </PackageCard>
  );
}

export function PackagePreviewView({
  preview,
  changed,
  refreshing,
  applying,
  onCancel,
  onApply,
  onRefresh,
}: {
  preview: PackagePreviewResult;
  changed: boolean;
  refreshing: boolean;
  applying: boolean;
  onCancel(): void;
  onApply(): void;
  onRefresh(): void;
}) {
  const { t, dateTime } = useI18n();
  const plan = preview.plan;
  const rows = useMemo(() => sortedPlanItems(plan), [plan]);
  const columns = useMemo<CockpitColumn<PackagePlanItem>[]>(() => {
    const column = tableColumns<PackagePlanItem>({ t, dateTime });
    return [
      column.custom(
        "kind",
        (item) => item.kind,
        t("settings.packages.import.column.kind"),
        (item) => t(KIND_LABEL[item.kind]),
        { width: "w-[18%]" },
      ),
      column.custom(
        "key",
        (item) => item.key,
        t("settings.packages.import.column.key"),
        (item) => <span className="break-all font-mono text-xs">{item.key}</span>,
        { width: "w-[30%]" },
      ),
      column.custom(
        "action",
        (item) => item.action,
        t("settings.packages.import.column.action"),
        (item) => (
          <StatusBadge
            state={actionTone(item.action)}
            label={t(ACTION_LABEL[item.action])}
            testId={`settings-packages-action-${item.kind}-${item.key}`}
          />
        ),
        { width: "w-[16%]" },
      ),
      column.custom(
        "hint",
        (item) => item.reason ?? null,
        t("settings.packages.import.column.hint"),
        (item) => {
          const hint = planHint(item);
          return (
            <span className="text-muted-foreground">
              {hint ? t(hint.key, hint.values) : MISSING}
            </span>
          );
        },
        { width: "w-[36%]" },
      ),
    ];
  }, [t, dateTime]);
  const applicable = canApplyPlan(plan);
  return (
    <div className="grid gap-4" data-testid="settings-packages-preview">
      <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-3">
        <FileArchive aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="break-all font-mono text-xs">
          {t("settings.packages.import.packageLine", {
            package: plan.package_id,
            version: plan.package_version,
          })}
        </span>
      </div>
      {changed ? (
        <Alert variant="destructive" data-testid="settings-packages-preview-changed">
          <AlertDescription>
            {t("settings.packages.import.changed")}{" "}
            <Button
              variant="outline"
              size="sm"
              pending={refreshing}
              onClick={onRefresh}
              data-testid="settings-packages-preview-refresh"
            >
              {t("settings.packages.import.refresh")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <SummaryChips summary={plan.summary} testId="settings-packages-preview-summary" />
      <RecordTable
        columns={columns}
        data={rows}
        collectionId="settings-packages-preview"
        emptyLine={t("settings.packages.import.empty")}
        getRowId={(item) => `${item.kind}:${item.key}`}
        rowLabel={(item) => item.key}
      />
      <Alert data-testid="settings-packages-preview-landing">
        <Info aria-hidden="true" />
        <AlertDescription>{t("settings.packages.import.landing")}</AlertDescription>
      </Alert>
      {!applicable ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="settings-packages-preview-nothing"
        >
          {t("settings.packages.import.nothing")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          disabled={applying}
          onClick={onCancel}
          data-testid="settings-packages-preview-cancel"
        >
          {t("common.cancel")}
        </Button>
        <Button
          disabled={!applicable || changed}
          pending={applying}
          onClick={onApply}
          data-testid="settings-packages-preview-apply"
        >
          <Upload aria-hidden="true" />
          {t("settings.packages.import.apply")}
        </Button>
      </div>
    </div>
  );
}

function SummaryChips({
  summary,
  testId,
}: {
  summary: Partial<Record<string, unknown>>;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {summaryEntries(summary as Partial<Record<keyof typeof ACTION_LABEL, unknown>>).map(
        ({ action, count }) => (
          <StatusBadge
            key={action}
            state={actionTone(action)}
            label={`${t(ACTION_LABEL[action])} ${count}`}
            testId={`${testId}-${action}`}
          />
        ),
      )}
    </div>
  );
}

export function PackageResultView({
  result,
  onAnother,
}: {
  result: PackageApplyResult;
  onAnother(): void;
}) {
  const { t, tn } = useI18n();
  const steps = nextSteps(result);
  const failed = failedItems(result);
  return (
    <div className="grid gap-3 text-sm" data-testid="settings-packages-result">
      <Alert data-testid="settings-packages-result-summary">
        <CircleCheck aria-hidden="true" className="text-emerald-600" />
        <AlertDescription>
          <span className="font-medium text-foreground">{t("settings.packages.result.title")}</span>{" "}
          {t("settings.packages.result.summary", {
            create: result.summary.create,
            update: result.summary.update,
            unchanged: result.summary.unchanged,
            conflict: result.summary.conflict,
          })}{" "}
          {t("settings.packages.result.inactive")}
        </AlertDescription>
      </Alert>
      {failed.length > 0 ? (
        <Alert variant="destructive" data-testid="settings-packages-result-failed">
          <AlertDescription>
            {t("settings.packages.result.failed", { keys: failed.join(", ") })}
          </AlertDescription>
        </Alert>
      ) : null}
      {steps.length > 0 ? (
        <ol className="grid gap-2" data-testid="settings-packages-next">
          {steps.map((next, index) => (
            <li
              key={next.id}
              className="grid gap-2 rounded-lg border px-3 py-2"
              data-testid={`settings-packages-next-${next.id}`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex size-5 items-center justify-center rounded-full border text-xs tabular-nums">
                  {index + 1}
                </span>
                {tn(next.label, next.count)}
                <Link
                  {...routerTarget(absolute(next.href))}
                  className={`ml-auto ${LINK_CLASS}`}
                  data-testid={`settings-packages-next-${next.id}-open`}
                >
                  {t(next.open)}
                </Link>
              </div>
              {next.reviews && next.reviews.length > 1 ? (
                <ul className="flex flex-wrap gap-x-3 gap-y-1 pl-8 text-xs">
                  {next.reviews.map((review) => (
                    <li key={review.path}>
                      <Link
                        {...routerTarget(absolute(review.path))}
                        className={`font-mono ${LINK_CLASS}`}
                        data-testid={`settings-packages-review-${review.key}`}
                      >
                        @{review.key}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={onAnother}
          data-testid="settings-packages-result-another"
        >
          {t("settings.packages.result.another")}
        </Button>
      </div>
    </div>
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
