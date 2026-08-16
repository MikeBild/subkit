import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { ContextHelp } from "@/components/cockpit/context-help";
import { IconButton } from "@/components/cockpit/icon-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { statusLabel } from "@/lib/status-label";

type Execution = components["schemas"]["Execution"];
type ExecutionList = components["schemas"]["ExecutionListResponse"];
type ExecutionStep = components["schemas"]["ExecutionStep"];
type ExecutionStepList = components["schemas"]["ExecutionStepListResponse"];

export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
] as const;

const SOURCE_KIND_KEYS: Record<Execution["source_kind"], TranslationKey> = {
  saved: "runs.sourceKind.saved",
  draft: "runs.sourceKind.draft",
  step: "runs.sourceKind.step",
};

const REQUEST_SOURCE_KEYS: Partial<Record<string, TranslationKey>> = {
  api: "runs.source.api",
  cli: "runs.source.cli",
  mcp: "runs.source.mcp",
  webhook: "runs.source.webhook",
  "tool-chain": "runs.source.toolChain",
  scheduler: "runs.source.scheduler",
  chat: "runs.source.chat",
};

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function runName(run: Execution, t: Translate): string {
  if (run.workflow_name?.trim()) return run.workflow_name;
  return t(SOURCE_KIND_KEYS[run.source_kind] ?? "runs.sourceKind.saved");
}

function requestSourceLabel(source: string, t: Translate): string {
  const key = REQUEST_SOURCE_KEYS[source];
  return key ? t(key) : t("common.unknown");
}

export function formatRunDuration(locale: Locale, ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) {
    const seconds = new Intl.NumberFormat(LOCALE_TAGS[locale], {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(tenths);
    return `${seconds} s`;
  }
  // Round to whole seconds first so 119.6 s carries into "2m 0s", never "1m 60s".
  const totalSeconds = Math.round(ms / 1_000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

export function runDurationMs(run: Pick<Execution, "started_at" | "finished_at">): number | null {
  if (!run.started_at || !run.finished_at) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function previewText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text?.trim() ? text : null;
}

function RunDuration({ run }: { run: Pick<Execution, "started_at" | "finished_at"> }) {
  const { locale } = useI18n();
  const ms = runDurationMs(run);
  return <>{ms === null ? "—" : formatRunDuration(locale, ms)}</>;
}

function EvidenceBlock({
  title,
  text,
  tone,
  testId,
}: {
  title: string;
  text: string;
  tone: "error" | "result";
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <pre
        className={`rounded-lg border p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap ${
          tone === "error" ? "border-destructive/40 bg-destructive/5" : "bg-muted/40"
        }`}
        data-testid={testId}
      >
        {hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
      </pre>
    </section>
  );
}

function RunDetail({ run }: { run: Execution }) {
  const { t, dateTime, locale } = useI18n();
  const detail = useQuery({
    queryKey: ["run", run.id],
    queryFn: () => apiRequest<Execution>(`/v1/executions/${encodeURIComponent(run.id)}`),
  });
  const steps = useQuery({
    queryKey: ["run-steps", run.id],
    queryFn: () =>
      apiRequest<ExecutionStepList>(`/v1/executions/${encodeURIComponent(run.id)}/steps`),
  });
  const current = detail.data ?? run;
  const stepItems: ExecutionStep[] = steps.data?.items ?? [];
  const failedStep = stepItems.find((step) => previewText(step.error) !== null);
  const errorEvidence = failedStep ? previewText(failedStep.error) : null;
  const resultStep = [...stepItems]
    .reverse()
    .find((step) => previewText(step.output_preview ?? step.result_preview) !== null);
  const resultEvidence = resultStep
    ? previewText(resultStep.output_preview ?? resultStep.result_preview)
    : null;
  const facts: Array<[string, string]> = [
    [t("resource.field.status"), statusLabel(t, current.status)],
    [t("runs.column.started"), current.started_at ? dateTime(current.started_at) : "—"],
    [t("runs.detail.finished"), current.finished_at ? dateTime(current.finished_at) : "—"],
    [
      t("runs.column.duration"),
      runDurationMs(current) === null
        ? "—"
        : formatRunDuration(locale, runDurationMs(current) ?? 0),
    ],
    [t("runs.column.source"), requestSourceLabel(current.request_source, t)],
    [t("resource.field.kind"), t(SOURCE_KIND_KEYS[current.source_kind] ?? "runs.sourceKind.saved")],
  ];

  return (
    <div className="grid gap-5 p-4">
      <dl className="grid grid-cols-2 gap-3" data-testid="run-detail-facts">
        {facts.map(([label, value]) => (
          <div key={label} className="grid gap-1 border-b pb-2">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="text-sm break-words">{value}</dd>
          </div>
        ))}
      </dl>

      {detail.error || steps.error ? (
        <Alert variant="destructive" data-testid="run-detail-error-state">
          <AlertTitle>{t("runs.detail.loadFailed")}</AlertTitle>
          <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="run-detail-retry"
            onClick={() => {
              void detail.refetch();
              void steps.refetch();
            }}
          >
            {t("session.retry")}
          </Button>
        </Alert>
      ) : steps.isPending ? (
        <div className="grid gap-3" data-testid="run-detail-loading">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <>
          {errorEvidence && (
            <EvidenceBlock
              title={t("tool.error")}
              text={errorEvidence}
              tone="error"
              testId="run-detail-error"
            />
          )}
          {resultEvidence && (
            <EvidenceBlock
              title={t("tool.result")}
              text={resultEvidence}
              tone="result"
              testId="run-detail-result"
            />
          )}
          <section className="grid gap-2" data-testid="run-detail-steps">
            <h3 className="text-sm font-medium">{t("runs.detail.steps")}</h3>
            {stepItems.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="run-detail-no-steps">
                {t("runs.detail.noSteps")}
              </p>
            ) : (
              stepItems.map((step, index) => {
                const stepError = previewText(step.error);
                return (
                  <div
                    key={`${step.step_key}-${index}`}
                    className="rounded-lg border p-3"
                    data-testid={`run-detail-step-${index}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate text-sm font-medium">{step.step_key}</p>
                      <Badge variant="outline">{statusLabel(t, step.status)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {step.duration_ms === null
                        ? "—"
                        : formatRunDuration(locale, step.duration_ms)}
                    </p>
                    {stepError && (
                      <pre className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                        {hideTechnicalIdentifiers(stepError, t("tool.referenceHiddenInline"))}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function RunsPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Execution | null>(null);
  const allowed = session.permissions.includes("execution:read");
  const title = t("resource.runs.title");
  const query = useQuery({
    queryKey: ["runs", statusFilter],
    enabled: allowed,
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      return apiRequest<ExecutionList>(`/v1/executions?${params}`);
    },
  });
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((run) => runName(run, t).toLowerCase().includes(needle));
  }, [items, search, t]);
  const total = query.data?.total ?? filtered.length;

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="resource-runs">
      <header
        className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-end sm:justify-between"
        data-testid="runs-header"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="runs-title">
              {title}
            </h1>
            <ContextHelp label={t("resource.about", { resource: title })} testId="runs-description">
              {t("resource.runs.description")}
            </ContextHelp>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 p-4" data-testid="runs-toolbar">
        <InputGroup className="w-full sm:max-w-sm">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("runs.search")}
            aria-label={t("runs.search")}
            data-testid="runs-search"
          />
        </InputGroup>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger
            className="w-44"
            aria-label={t("catalog.filterStatus")}
            data-testid="runs-status-filter"
          >
            <SelectValue placeholder={t("catalog.allStatuses")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all" data-testid="runs-status-all">
                {t("catalog.allStatuses")}
              </SelectItem>
              {RUN_STATUSES.map((status) => (
                <SelectItem key={status} value={status} data-testid={`runs-status-${status}`}>
                  {statusLabel(t, status)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="runs-refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      </div>

      {query.isPending ? (
        <div
          className="grid gap-3 p-6"
          data-testid="runs-loading"
          role="status"
          aria-label={t("common.loading")}
        >
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : query.error ? (
        <Alert variant="destructive" className="m-6" data-testid="runs-error">
          <AlertTitle>{t("resource.loadFailed", { resource: title })}</AlertTitle>
          <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="runs-retry"
            onClick={() => void query.refetch()}
          >
            {t("session.retry")}
          </Button>
        </Alert>
      ) : filtered.length === 0 ? (
        <Empty className="flex-1" data-testid="runs-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>{search ? t("resource.noMatches") : t("resource.runs.empty")}</EmptyTitle>
            <EmptyDescription>
              {search ? t("resource.broaderSearch") : t("resource.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="h-0 min-h-0 flex-1 px-4 pb-4" data-testid="runs-results">
          <Card className="min-w-0 overflow-hidden" data-testid="runs-table-card">
            <CardHeader className="sr-only">
              <CardTitle>{title}</CardTitle>
              <CardDescription>{t("resource.records", { count: filtered.length })}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="hidden md:block" data-testid="runs-desktop-table">
                <Table data-testid="runs-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[30%]">{t("runs.column.workflow")}</TableHead>
                      <TableHead className="w-[16%]">{t("resource.field.status")}</TableHead>
                      <TableHead className="w-[22%]">{t("runs.column.started")}</TableHead>
                      <TableHead className="w-[14%]">{t("runs.column.duration")}</TableHead>
                      <TableHead className="w-[18%]">{t("runs.column.source")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((run, index) => (
                      <TableRow key={index} data-testid={`runs-row-${index}`}>
                        <TableCell className="max-w-0 min-w-0">
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-auto max-w-full justify-start p-0 text-left font-medium hover:bg-transparent hover:underline"
                            data-testid={`runs-row-${index}-open`}
                            onClick={() => setSelected(run)}
                          >
                            <span className="truncate">{runName(run, t)}</span>
                          </Button>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{statusLabel(t, run.status)}</Badge>
                        </TableCell>
                        <TableCell className="max-w-0 min-w-0 truncate">
                          {run.started_at ? dateTime(run.started_at) : "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          <RunDuration run={run} />
                        </TableCell>
                        <TableCell className="max-w-0 min-w-0 truncate">
                          {requestSourceLabel(run.request_source, t)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="grid divide-y md:hidden" data-testid="runs-mobile-list">
                {filtered.map((run, index) => (
                  <article
                    className="grid min-w-0 gap-3 p-4"
                    key={index}
                    data-testid="runs-mobile-row"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto min-w-0 justify-start p-0 text-left font-medium hover:bg-transparent hover:underline"
                      data-testid={`runs-mobile-row-${index}-open`}
                      onClick={() => setSelected(run)}
                    >
                      <span className="truncate">{runName(run, t)}</span>
                    </Button>
                    <dl className="grid min-w-0 gap-2">
                      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
                        <dt className="text-xs text-muted-foreground">
                          {t("resource.field.status")}
                        </dt>
                        <dd className="min-w-0 text-right text-sm">
                          <Badge variant="outline">{statusLabel(t, run.status)}</Badge>
                        </dd>
                      </div>
                      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
                        <dt className="text-xs text-muted-foreground">
                          {t("runs.column.started")}
                        </dt>
                        <dd className="min-w-0 text-right text-sm [overflow-wrap:anywhere]">
                          {run.started_at ? dateTime(run.started_at) : "—"}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </CardContent>
            <CardFooter className="flex-wrap justify-between gap-2 border-t py-3 text-xs text-muted-foreground">
              <span>{t("runs.showing", { count: filtered.length, total })}</span>
              <span>{t("resource.workspaceScoped")}</span>
            </CardFooter>
          </Card>
        </ScrollArea>
      )}

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-xl"
          closeLabel={t("common.close")}
          closeTestId="run-detail-close"
          data-testid="run-detail"
        >
          <SheetHeader>
            <SheetTitle data-testid="run-detail-title">
              {selected ? runName(selected, t) : title}
            </SheetTitle>
            <SheetDescription>{t("runs.detail.description")}</SheetDescription>
          </SheetHeader>
          {selected && <RunDetail run={selected} />}
        </SheetContent>
      </Sheet>
    </main>
  );
}
