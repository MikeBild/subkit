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
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";

import {
  applyPackage,
  exportPackage,
  PACKAGE_KINDS,
  type PackageApplyResult,
  type PackageExportResult,
  type PackageKind,
  type PackagePlanItem,
  type PackagePreviewResult,
  packageArchiveHref,
  previewPackageFile,
  previewStoredPackage,
} from "@/api/packages";
import { exportInstallationFile } from "@/app/installation-export";
import { absolute, routerTarget } from "@/app/links";
import type { CategoryUsage } from "@/components/cockpit/catalog-categories-model";
import {
  type ActionMenuItem,
  Button,
  Chip,
  type CockpitColumn,
  type DialogError,
  dialogFailure,
  FileDrop,
  FormDialog,
  SearchInput,
  StatusBadge,
  WizardProgress,
} from "@/components/cockpit/patterns";
import { Alert, AlertDescription, Checkbox } from "@/components/cockpit/patterns/controls";
import { RecordTable } from "@/components/cockpit/record-table";
import { bytes, MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory } from "@/lib/workflow-category";
import {
  ACTION_LABEL,
  actionTone,
  CATEGORY_SEARCH_THRESHOLD,
  canApplyPlan,
  canSubmitImport,
  exportCategoryOptions,
  failedItems,
  filterExportCategories,
  KIND_LABEL,
  KINDS_LABEL,
  nextSteps,
  type PackageExportPrefill,
  packageCategories,
  packageMenuItems,
  planFromConflict,
  planHint,
  REQUIREMENT_LABEL,
  requirementCounts,
  sortedPlanItems,
  summaryEntries,
} from "@/pages/settings-packages-model";

const PACKAGE_MAX_BYTES = 256 * 1024 * 1024;
const LINK_CLASS = "font-medium text-primary underline-offset-4 hover:underline";

const IMPORT_INVALIDATIONS: readonly (readonly string[])[] = [
  ["packages", "installs"],
  ["catalog"],
  ["catalog-detail"],
  ["catalog-categories"],
  ["intake"],
  ["connectors"],
  ["workflows"],
  ["catalog-workflow-index"],
  ["attention"],
  ["decisions"],
];

const REQUIREMENT_ICON = {
  credential: KeyRound,
  approval: ShieldCheck,
  schedule_resume: Clock,
  knowledge_review: Inbox,
} as const;

function useOpenSession(open: boolean): number {
  const [session, setSession] = useState(0);
  const [shown, setShown] = useState(open);
  if (open !== shown) {
    setShown(open);
    if (open) setSession((current) => current + 1);
  }
  return session;
}

export function PackageExportDialog({
  open,
  onOpenChange,
  initialKinds,
  initialCategories,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialKinds?: readonly PackageKind[];
  initialCategories?: readonly string[];
}) {
  const session = useOpenSession(open);
  return (
    <ExportDialogBody
      key={session}
      open={open}
      onOpenChange={onOpenChange}
      initialKinds={initialKinds}
      initialCategories={initialCategories}
    />
  );
}

function ExportDialogBody({
  open,
  onOpenChange,
  initialKinds,
  initialCategories,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialKinds?: readonly PackageKind[];
  initialCategories?: readonly string[];
}) {
  const { t } = useI18n();
  const [kinds, setKinds] = useState<ReadonlySet<PackageKind>>(
    () => new Set(initialKinds && initialKinds.length > 0 ? initialKinds : PACKAGE_KINDS),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(packageCategories(initialCategories)),
  );
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState(false);
  const categories = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: () => apiCall("get", "/v1/categories", {}),

    enabled: open,
  });
  const run = useMutation({
    mutationFn: () =>
      exportPackage({
        kinds: PACKAGE_KINDS.filter((kind) => kinds.has(kind)),
        categories: [...selected],
      }),
  });
  const result = run.data;
  const toggle =
    <T,>(set: (update: (current: ReadonlySet<T>) => ReadonlySet<T>) => void) =>
    (value: T, checked: boolean) =>
      set((current) => {
        const next = new Set(current);
        if (checked) next.add(value);
        else next.delete(value);
        return next;
      });
  const download = async (value: PackageExportResult) => {
    const href = packageArchiveHref(value.file_id);
    setDownloading(true);
    try {
      const saved = await exportInstallationFile(
        value.filename,
        async () => await fetch(href, { credentials: "same-origin" }),
      );
      if (saved === "unsupported") {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = value.filename;
        anchor.click();
      }
    } catch {
      reportFailure(t("settings.packages.export.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && run.isPending) return;
        onOpenChange(next);
      }}
      title={t("packages.export.title")}
      description={t("packages.export.description")}
      size="wide"
      step={result ? "result" : "choose"}
      submit={
        result
          ? undefined
          : {
              label: t("settings.packages.export.action"),
              pending: run.isPending,
              disabled: kinds.size === 0,
              testId: "settings-packages-export-run",
            }
      }
      onSubmit={() => {
        if (!result && kinds.size > 0 && !run.isPending) run.mutate();
      }}
      back={
        result
          ? {
              label: t("packages.dialog.back"),
              onClick: () => run.reset(),
              testId: "settings-packages-export-back",
            }
          : undefined
      }
      cancelLabel={result ? t("common.close") : undefined}
      error={run.isError ? t("settings.packages.export.failed") : null}
      failure={run.error}
      testId="settings-packages-export"
    >
      {result ? (
        <PackageExportResultView
          result={result}
          downloading={downloading}
          onDownload={() => void download(result)}
        />
      ) : (
        <PackageExportChoice
          kinds={kinds}
          onKind={toggle(setKinds)}
          categories={categories.data?.categories ?? []}
          categoriesPending={categories.isPending}
          selected={selected}
          onCategory={toggle(setSelected)}
          search={search}
          onSearch={setSearch}
          disabled={run.isPending}
        />
      )}
    </FormDialog>
  );
}

export function PackageExportChoice({
  kinds,
  onKind,
  categories,
  categoriesPending = false,
  selected,
  onCategory,
  search,
  onSearch,
  disabled = false,
}: {
  kinds: ReadonlySet<PackageKind>;
  onKind(kind: PackageKind, checked: boolean): void;
  categories: readonly CategoryUsage[];
  categoriesPending?: boolean;
  selected: ReadonlySet<string>;
  onCategory(category: string, checked: boolean): void;
  search: string;
  onSearch(value: string): void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const options = exportCategoryOptions(categories, kinds, selected);
  const shown = filterExportCategories(categories, options, search);
  return (
    <div className="grid gap-4" data-testid="settings-packages-export-choice">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">
          {t("settings.packages.export.kinds")}
        </legend>
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
                disabled={disabled}
                onCheckedChange={(checked) => onKind(kind, checked === true)}
                data-testid={`settings-packages-kind-${kind}`}
              />
              {t(KINDS_LABEL[kind])}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="grid gap-2" data-testid="settings-packages-categories">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">
          {t("packages.export.categories")}
        </legend>
        {options.length > CATEGORY_SEARCH_THRESHOLD ? (
          <search
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          >
            <SearchInput
              value={search}
              onChange={onSearch}
              label={t("packages.export.categorySearch")}
              testId="settings-packages-category-search"
            />
          </search>
        ) : null}
        {shown.length > 0 ? (
          <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto text-sm @md:grid-cols-2 @3xl:grid-cols-3">
            {shown.map(({ category, count }) => (
              <label
                key={category}
                htmlFor={`settings-packages-category-${category}`}
                className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2"
              >
                <Checkbox
                  id={`settings-packages-category-${category}`}
                  checked={selected.has(category)}
                  disabled={disabled}
                  onCheckedChange={(checked) => onCategory(category, checked === true)}
                  data-testid={`settings-packages-category-${category}`}
                />
                <span className="truncate">
                  {humanizeCategory(category, t("catalog.categoryOther"))}
                </span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span>
              </label>
            ))}
          </div>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="settings-packages-categories-empty"
          >
            {categoriesPending
              ? t("packages.export.categoriesLoading")
              : t("packages.export.categoriesNone")}
          </p>
        )}
        <p
          className="text-xs text-muted-foreground"
          data-testid="settings-packages-categories-hint"
        >
          {selected.size === 0
            ? t("packages.export.categoriesAll")
            : t("packages.export.categoriesSome")}
        </p>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        {t("settings.packages.export.dependencies")}. {t("settings.packages.export.scope")}
      </p>
    </div>
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
          type="button"
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

export function PackageImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const session = useOpenSession(open);
  return <ImportDialogBody key={session} open={open} onOpenChange={onOpenChange} />;
}

function ImportDialogBody({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [stage, setStage] = useState<ImportStage>(null);
  const [result, setResult] = useState<PackageApplyResult | null>(null);
  const [failure, setFailure] = useState<DialogError>(null);
  const preview = useMutation({
    mutationFn: (source: File | string) =>
      typeof source === "string" ? previewStoredPackage(source) : previewPackageFile(source),
    onMutate: () => setFailure(null),
    onSuccess: (value) => setStage({ preview: value, changed: false }),
    onError: (error) =>
      setFailure(
        error instanceof ApiError && error.status === 413
          ? t("settings.packages.import.tooLarge")
          : dialogFailure(t("settings.packages.import.previewFailed"), error),
      ),
  });
  const apply = useMutation({
    mutationFn: (value: PackagePreviewResult) =>
      applyPackage(value.archive_file_id, value.plan.plan_digest),
    onMutate: () => setFailure(null),
    onSuccess: (value) => {
      setStage(null);
      setResult(value);
      for (const queryKey of IMPORT_INVALIDATIONS)
        void client.invalidateQueries({ queryKey: [...queryKey] });
    },
    onError: (error, value) => {
      if (error instanceof ApiError && error.status === 409) {
        const plan = planFromConflict(error.details);
        setStage({ preview: plan ? { ...value, plan } : value, changed: true });
        return;
      }
      setFailure(dialogFailure(t("settings.packages.import.applyFailed"), error));
    },
  });
  const reset = () => {
    setStage(null);
    setResult(null);
    setFailure(null);
  };
  const reviewing = stage !== null && result === null;
  const submittable = stage !== null && canSubmitImport(stage.preview.plan, stage.changed);
  const current = result ? 2 : stage ? 1 : 0;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && apply.isPending) return;
        onOpenChange(next);
      }}
      title={t("packages.import.title")}
      description={t("packages.import.description")}
      size="wide"
      step={result ? "result" : stage ? "preview" : "file"}
      submit={
        reviewing
          ? {
              label: t("settings.packages.import.apply"),
              pending: apply.isPending,
              disabled: !submittable,
              testId: "settings-packages-preview-apply",
            }
          : undefined
      }
      onSubmit={() => {
        if (stage && submittable && !apply.isPending) apply.mutate(stage.preview);
      }}
      hint={
        reviewing
          ? t("settings.packages.import.consequence", {
              create: stage.preview.plan.summary.create,
              update: stage.preview.plan.summary.update,
            })
          : undefined
      }
      back={
        reviewing
          ? {
              label: t("packages.dialog.back"),
              onClick: () => {
                setStage(null);
                setFailure(null);
              },
              testId: "settings-packages-preview-cancel",
            }
          : undefined
      }
      cancelLabel={result ? t("common.close") : undefined}
      error={failure}
      testId="settings-packages-import"
    >
      <WizardProgress
        steps={[
          t("settings.packages.import.stepFile"),
          t("settings.packages.import.stepPreview"),
          t("settings.packages.import.stepResult"),
        ]}
        current={current}
        testId="settings-packages-import-step"
      />
      {result ? (
        <PackageResultView result={result} onAnother={reset} />
      ) : stage ? (
        <PackagePreviewView
          preview={stage.preview}
          changed={stage.changed}
          refreshing={preview.isPending}
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
    </FormDialog>
  );
}

export function PackagePreviewView({
  preview,
  changed,
  refreshing,
  onRefresh,
}: {
  preview: PackagePreviewResult;
  changed: boolean;
  refreshing: boolean;
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
        { width: "w-[36%]", priority: "low" },
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
              type="button"
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
          type="button"
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

export function usePackageActions({
  permissions,
  kind,
  category,
}: {
  permissions: readonly string[];
  kind: PackageKind;
  category: string | undefined;
}): { items: ActionMenuItem[]; dialogs: ReactNode; open: boolean } {
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const [prefill, setPrefill] = useState<PackageExportPrefill | null>(null);
  const [importing, setImporting] = useState(false);
  const items = packageMenuItems({
    permissions,
    kind,
    category,
    t,
    onExport: (next) => {
      setPrefill(next);
      setExporting(true);
    },
    onImport: () => setImporting(true),
  });
  const dialogs =
    items.length > 0 ? (
      <>
        <PackageExportDialog
          open={exporting}
          onOpenChange={setExporting}
          initialKinds={prefill?.kinds}
          initialCategories={prefill?.categories}
        />
        <PackageImportDialog open={importing} onOpenChange={setImporting} />
      </>
    ) : null;
  return { items, dialogs, open: exporting || importing };
}
