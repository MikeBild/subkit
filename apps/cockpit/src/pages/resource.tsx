import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, Bot, RefreshCw, Search, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";

interface ResourceConfig {
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  endpoint: string | readonly string[] | (() => string);
  permission: string;
  actionKey?: TranslationKey;
  emptyKey: TranslationKey;
}

export const RESOURCE_CONFIGS: Record<string, ResourceConfig> = {
  inbox: resource("inbox", "/v1/notifications/inbox?limit=200", "notification:read"),
  workflows: resource("workflows", "/v1/workflows?limit=200", "workflow:read", true),
  runs: resource("runs", "/v1/executions?limit=200", "execution:read"),
  connectors: resource("connectors", "/v1/connectors", "connector:read", true),
  knowledge: resource("knowledge", "/v1/knowledge-sources?limit=200", "knowledge:read", true),
  skills: resource("skills", "/v1/skills?limit=200", "skill:read", true),
  files: resource("files", "/v1/files?limit=100", "file:read"),
  approvals: {
    ...resource(
      "approvals",
      ["/v1/skill-candidates?limit=200", "/v1/patch-candidates?limit=200"],
      "conversation:approve",
    ),
  },
  audit: resource("audit", "/v1/audit-log?limit=200", "audit:read"),
  usage: resource("usage", usageStatsEndpoint, "stats:read"),
  people: resource("people", "/v1/identity/users", "identity:read"),
  access: resource("access", "/v1/rbac/roles", "rbac:read"),
  "api-access": resource("apiAccess", "/v1/identity/api-keys", "api_key:read"),
  operations: resource("operations", "/v1/operator/health-digest", "stats:read"),
  settings: resource("settings", "/v1/settings", "settings:read"),
};

function resource(
  key: string,
  endpoint: string | readonly string[] | (() => string),
  permission: string,
  action = false,
): ResourceConfig {
  return {
    titleKey: `resource.${key}.title` as TranslationKey,
    descriptionKey: `resource.${key}.description` as TranslationKey,
    endpoint,
    permission,
    actionKey: action ? (`resource.${key}.action` as TranslationKey) : undefined,
    emptyKey: `resource.${key}.empty` as TranslationKey,
  };
}

export function usageStatsEndpoint(now = new Date()): string {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  return `/v1/stats/executions?bucket=day&from=${encodeURIComponent(from.toISOString())}`;
}

function rowsFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
    );
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) return rowsFrom(record.items);
  return [record];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function presentationRows(
  resourceName: string,
  results: readonly unknown[],
): Record<string, unknown>[] {
  if (resourceName === "settings") {
    return rowsFrom(results[0]).map((row) => {
      const meta = isRecord(row.meta) ? row.meta : {};
      return {
        path: row.path,
        value: row.value,
        source: meta.source,
        scope: meta.scope,
        requires_restart: meta.requiresRestart,
      };
    });
  }

  if (resourceName === "usage") {
    const envelope = isRecord(results[0]) ? results[0] : {};
    const groups = Array.isArray(envelope.groups) ? envelope.groups : [];
    return groups.flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.buckets)) return [];
      return group.buckets.flatMap((bucket) => {
        if (!isRecord(bucket)) return [];
        const duration = isRecord(bucket.duration_ms) ? bucket.duration_ms : {};
        return [
          {
            date: bucket.ts,
            executions: bucket.executions,
            average_duration_ms: duration.avg,
            p95_duration_ms: duration.p95,
          },
        ];
      });
    });
  }

  if (resourceName === "operations") {
    const digest = isRecord(results[0]) ? results[0] : {};
    const generatedAt = digest.generated_at;
    const failures = Array.isArray(digest.failure_groups)
      ? digest.failure_groups.flatMap((failure) => {
          if (!isRecord(failure)) return [];
          return [
            {
              headline: failure.workflow_name || failure.cause,
              status: "failed",
              count: failure.count,
              updated_at: failure.last_seen,
            },
          ];
        })
      : [];
    const risks = Array.isArray(digest.risk)
      ? digest.risk.flatMap((risk) => {
          if (!isRecord(risk)) return [];
          return [
            {
              headline: risk.headline,
              severity: risk.severity,
              value: risk.value,
              updated_at: generatedAt,
            },
          ];
        })
      : [];
    if (failures.length || risks.length) return [...failures, ...risks];
    if (typeof digest.headline === "string") {
      return [{ headline: digest.headline, status: "completed", updated_at: generatedAt }];
    }
  }

  return results.flatMap(rowsFrom);
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const UUID_GLOBAL = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const HIDDEN_FIELD = /(^id$|_id$|^tenant_|uuid|token|secret|password|hash|credential|csrf)/i;

function isReadableField(key: string): boolean {
  return !HIDDEN_FIELD.test(key);
}

function readableScalar(value: unknown): value is string | number | boolean {
  return (
    ["string", "number", "boolean"].includes(typeof value) &&
    !(typeof value === "string" && UUID.test(value))
  );
}

function primaryColumns(rows: Record<string, unknown>[]): string[] {
  const preferred = [
    "name",
    "display_name",
    "title",
    "slug",
    "status",
    "type",
    "kind",
    "category",
    "email",
    "action",
    "headline",
    "path",
    "value",
    "date",
    "executions",
    "average_duration_ms",
    "p95_duration_ms",
    "source",
    "scope",
    "requires_restart",
    "created_at",
    "updated_at",
  ];
  const keys = new Set(rows.flatMap((row) => Object.keys(row).filter(isReadableField)));
  const selected = preferred.filter((key) => keys.has(key));
  if (selected.length > 0) return selected.slice(0, 5);
  return [...keys].filter((key) => rows.some((row) => readableScalar(row[key]))).slice(0, 5);
}

function recordName(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  for (const key of ["name", "display_name", "title", "slug", "email"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && !UUID.test(value)) return value;
  }
  return null;
}

function fieldLabel(key: string, t: ReturnType<typeof useI18n>["t"]): string {
  const known: Partial<Record<string, TranslationKey>> = {
    created_at: "resource.field.createdAt",
    updated_at: "resource.field.updatedAt",
    display_name: "resource.field.displayName",
    role_name: "resource.field.roleName",
    mime_type: "resource.field.mimeType",
    byte_size: "resource.field.byteSize",
    last_used_at: "resource.field.lastUsedAt",
    expires_at: "resource.field.expiresAt",
    created_by: "resource.field.createdBy",
    name: "resource.field.name",
    title: "resource.field.title",
    slug: "resource.field.slug",
    status: "resource.field.status",
    type: "resource.field.type",
    kind: "resource.field.kind",
    category: "resource.field.category",
    email: "resource.field.email",
    action: "resource.field.action",
    path: "resource.field.path",
    value: "resource.field.value",
    date: "resource.field.date",
    executions: "resource.field.executions",
    average_duration_ms: "resource.field.averageDuration",
    p95_duration_ms: "resource.field.p95Duration",
    source: "resource.field.source",
    scope: "resource.field.scope",
    requires_restart: "resource.field.requiresRestart",
    headline: "resource.field.headline",
    severity: "resource.field.severity",
  };
  return known[key] ? t(known[key]) : t("resource.field.other");
}

function DisplayValue({ field, value }: { field: string; value: unknown }) {
  const { t, dateTime } = useI18n();
  if (value === null || value === undefined || value === "") return <>—</>;
  if (typeof value === "boolean") return <>{t(value ? "common.yes" : "common.no")}</>;
  if (Array.isArray(value)) return <>{t("common.items", { count: value.length })}</>;
  if (typeof value === "object") return <>{t("common.details")}</>;
  if (typeof value === "string" && UUID.test(value)) return <>{value.replace(UUID_GLOBAL, "—")}</>;
  if (typeof value === "string" && /_at$/.test(field)) return <>{dateTime(value)}</>;
  if (field === "date" && typeof value === "string") return <>{dateTime(value)}</>;
  if (/_duration_ms$/.test(field) && typeof value === "number") return <>{formatDuration(value)}</>;
  if (field === "status" && typeof value === "string") return <>{statusLabel(t, value)}</>;
  return <>{String(value)}</>;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function numberAt(record: unknown, ...path: string[]): number {
  let current: unknown = record;
  for (const part of path) current = isRecord(current) ? current[part] : undefined;
  return typeof current === "number" ? current : 0;
}

function UsageSummary({ value }: { value: unknown }) {
  const { t } = useI18n();
  const count = numberAt(value, "totals", "executions", "count");
  const average = numberAt(value, "totals", "duration_ms", "avg");
  const p95 = numberAt(value, "totals", "duration_ms", "p95");
  const statuses =
    isRecord(value) && isRecord(value.totals) && isRecord(value.totals.executions)
      ? value.totals.executions.by_status
      : undefined;
  const completed = isRecord(statuses)
    ? ["completed", "succeeded", "success"].reduce(
        (total, key) => total + (typeof statuses[key] === "number" ? statuses[key] : 0),
        0,
      )
    : 0;
  const successRate = count > 0 ? `${Math.round((completed / count) * 100)}%` : "—";
  const cards = [
    ["resource.usage.executions", String(count)],
    ["resource.usage.averageDuration", formatDuration(average)],
    ["resource.usage.p95Duration", formatDuration(p95)],
    ["resource.usage.successRate", successRate],
  ] as const;

  return (
    <section
      className="grid grid-cols-2 gap-3 px-4 pb-4 xl:grid-cols-4"
      data-testid="usage-summary"
    >
      {cards.map(([label, display], index) => (
        <Card key={label} size="sm" data-testid={`usage-summary-${index}`}>
          <CardHeader>
            <CardDescription>{t(label)}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{display}</CardTitle>
          </CardHeader>
          <CardFooter className="text-xs text-muted-foreground">
            {t("resource.usage.window")}
          </CardFooter>
        </Card>
      ))}
    </section>
  );
}

function RecordDetails({ record }: { record: Record<string, unknown> }) {
  const { t } = useI18n();
  const entries = Object.entries(record).filter(
    ([key, value]) => isReadableField(key) && readableScalar(value),
  );
  return (
    <dl className="grid gap-4 p-4" data-testid="resource-detail-fields">
      {entries.map(([key, value]) => (
        <div key={key} className="grid gap-1 border-b pb-3 last:border-b-0">
          <dt className="text-xs font-medium text-muted-foreground">{fieldLabel(key, t)}</dt>
          <dd className="break-words text-sm">
            <DisplayValue field={key} value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function WorkflowDetail({ selected }: { selected: Record<string, unknown> }) {
  const { t } = useI18n();
  const workflowId = typeof selected.id === "string" ? selected.id : null;
  const query = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => apiRequest<Record<string, unknown>>(`/v1/workflows/${workflowId}`),
    enabled: Boolean(workflowId),
  });
  const steps = query.data && Array.isArray(query.data.steps) ? rowsFrom(query.data.steps) : [];
  const workflowName = recordName(selected) ?? t("resource.workflows.title");
  const repairPrompt = encodeURIComponent(`${t("workflow.edit")}: ${workflowName}`);

  return (
    <div className="grid gap-4 p-4" data-testid="workflow-detail">
      <Button asChild className="w-full" data-testid="workflow-edit-action">
        <a href={`/cockpit/chat?prompt=${repairPrompt}`} data-testid="workflow-edit-link">
          <Bot data-icon="inline-start" />
          {t("workflow.edit")}
        </a>
      </Button>
      {query.isPending ? (
        <div className="grid gap-3" data-testid="workflow-detail-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.error ? (
        <Alert variant="destructive" data-testid="workflow-detail-error">
          <AlertTitle>{t("workflow.loadFailed")}</AlertTitle>
          <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
        </Alert>
      ) : steps.length === 0 ? (
        <Empty className="min-h-48 border" data-testid="workflow-steps-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Workflow />
            </EmptyMedia>
            <EmptyTitle>{t("workflow.noSteps")}</EmptyTitle>
            <EmptyDescription>{t("workflow.noStepsDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <section
          className="rounded-xl border bg-muted/30 p-4"
          aria-label={t("workflow.stepMap")}
          data-testid="workflow-step-map"
        >
          <div className="mb-4 flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span>{t("workflow.stepMap")}</span>
            <span>{t("workflow.steps", { count: steps.length })}</span>
          </div>
          <div className="flex flex-col items-center">
            {steps.map((step, index) => (
              <div className="contents" key={index}>
                <Card
                  className="w-full bg-background shadow-sm"
                  data-testid={`workflow-step-${index}`}
                >
                  <CardHeader className="gap-2 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="text-sm">
                        {recordName(step) ?? t("workflow.step", { count: index + 1 })}
                      </CardTitle>
                      {typeof step.kind === "string" && (
                        <Badge variant="secondary">{t("workflow.stepType")}</Badge>
                      )}
                    </div>
                    {typeof step.description === "string" && (
                      <CardDescription>{step.description}</CardDescription>
                    )}
                  </CardHeader>
                </Card>
                {index < steps.length - 1 && (
                  <ArrowDown className="my-2 text-muted-foreground" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <RecordDetails record={query.data ?? selected} />
    </div>
  );
}

export function ResourcePage({
  resource: resourceName,
  permissions,
}: {
  resource: string;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const config = RESOURCE_CONFIGS[resourceName];
  if (!config) throw new Error(`Unknown cockpit resource: ${resourceName}`);
  const title = t(config.titleKey);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const query = useQuery({
    queryKey: ["resource", resourceName],
    queryFn: async () => {
      const resolvedEndpoint =
        typeof config.endpoint === "function" ? config.endpoint() : config.endpoint;
      const endpoints =
        typeof resolvedEndpoint === "string" ? [resolvedEndpoint] : resolvedEndpoint;
      const results = await Promise.all(endpoints.map((endpoint) => apiRequest<unknown>(endpoint)));
      return { raw: results[0], rows: presentationRows(resourceName, results) };
    },
    enabled: permissions.includes(config.permission),
  });
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const filtered = useMemo(
    () => rows.filter((row) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase())),
    [rows, search],
  );
  const columns = primaryColumns(rows).slice(0, 4);
  const chatPrompt = encodeURIComponent(config.actionKey ? t(config.actionKey) : title);

  if (!permissions.includes(config.permission))
    return (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  return (
    <main
      className="flex min-h-0 flex-1 flex-col"
      data-cockpit-ui="resource-page"
      data-testid={`resource-${resourceName}`}
    >
      <header
        className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-end sm:justify-between"
        data-testid="resource-header"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="resource-title">
              {title}
            </h1>
            <ContextHelp
              label={t("resource.about", { resource: title })}
              testId="resource-description"
            >
              {t(config.descriptionKey)}
            </ContextHelp>
          </div>
        </div>
        {config.actionKey && (
          <Button asChild data-testid="resource-primary-action">
            <a href={`/cockpit/chat?prompt=${chatPrompt}`} data-testid="resource-primary-link">
              <Bot data-icon="inline-start" />
              {t(config.actionKey)}
            </a>
          </Button>
        )}
      </header>

      <div className="flex items-center gap-2 p-4" data-testid="resource-toolbar">
        <div className="relative w-full max-w-sm">
          <Search
            className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("resource.search", { resource: title.toLocaleLowerCase() })}
            className="pl-9"
            data-testid="resource-search"
          />
        </div>
        <IconButton
          variant="outline"
          size="icon"
          label={t("common.refresh")}
          data-testid="resource-refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      </div>

      {resourceName === "usage" && query.data && <UsageSummary value={query.data.raw} />}

      {query.isPending ? (
        <div
          className="grid gap-3 p-6"
          data-testid="resource-loading"
          role="status"
          aria-label={t("common.loading")}
        >
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : query.error ? (
        <Alert variant="destructive" className="m-6" data-testid="resource-error">
          <AlertTitle>{t("resource.loadFailed", { resource: title })}</AlertTitle>
          <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
        </Alert>
      ) : filtered.length === 0 ? (
        <Empty className="flex-1" data-testid="resource-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>{search ? t("resource.noMatches") : t(config.emptyKey)}</EmptyTitle>
            <EmptyDescription>
              {search ? t("resource.broaderSearch") : t("resource.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
          {config.actionKey && (
            <EmptyContent>
              <Button asChild variant="outline" data-testid="resource-empty-action">
                <a href={`/cockpit/chat?prompt=${chatPrompt}`} data-testid="resource-empty-link">
                  <Bot data-icon="inline-start" />
                  {t(config.actionKey)}
                </a>
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <ScrollArea className="h-0 min-h-0 flex-1 px-4 pb-4" data-testid="resource-results">
          <Card className="min-w-0 overflow-hidden" data-testid="resource-table-card">
            <CardHeader className="sr-only">
              <CardTitle>{title}</CardTitle>
              <CardDescription>{t("resource.records", { count: filtered.length })}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table data-testid="resource-table">
                <TableHeader>
                  <TableRow>
                    {columns.map((column, index) => (
                      <TableHead
                        key={column}
                        className={cn(
                          index === 0 && "w-[44%] lg:w-[34%]",
                          index === 1 && "w-[44%] lg:w-[24%]",
                          index >= 2 && "hidden lg:table-cell lg:w-[18%]",
                        )}
                      >
                        {fieldLabel(column, t)}
                      </TableHead>
                    ))}
                    <TableHead className="w-[12%] text-right lg:w-[6%]">
                      <span className="sr-only">{t("common.open")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row, index) => (
                    <TableRow key={index} data-testid={`resource-row-${index}`}>
                      {columns.map((column, columnIndex) => (
                        <TableCell
                          key={column}
                          className={cn(
                            "min-w-0 max-w-0 whitespace-normal break-words",
                            columnIndex >= 2 && "hidden lg:table-cell",
                          )}
                        >
                          {column === "status" ? (
                            <Badge variant="outline">
                              <DisplayValue field={column} value={row[column]} />
                            </Badge>
                          ) : (
                            <DisplayValue field={column} value={row[column]} />
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="w-[12%] text-right lg:w-[6%]">
                        <IconButton
                          label={`${t("common.open")}: ${recordName(row) ?? t("resource.detail.noName")}`}
                          data-testid={`resource-row-${index}-open`}
                          onClick={() => setSelected(row)}
                        >
                          <ArrowRight />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
            <CardFooter className="justify-between border-t py-3 text-xs text-muted-foreground">
              <span>{t("resource.records", { count: filtered.length })}</span>
              <span>{t("resource.workspaceScoped")}</span>
            </CardFooter>
          </Card>
        </ScrollArea>
      )}

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-xl"
          closeLabel={t("common.close")}
          closeTestId="resource-detail-close"
          data-testid="resource-detail"
        >
          <SheetHeader>
            <SheetTitle data-testid="resource-detail-title">
              {recordName(selected) ?? t("resource.detail.noName")}
            </SheetTitle>
            <SheetDescription>{t("resource.detail.description")}</SheetDescription>
          </SheetHeader>
          {selected && resourceName === "workflows" ? (
            <WorkflowDetail selected={selected} />
          ) : selected ? (
            <RecordDetails record={selected} />
          ) : null}
        </SheetContent>
      </Sheet>
    </main>
  );
}
