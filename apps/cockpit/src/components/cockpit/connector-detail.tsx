import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { absolute, workflowHref, workflowsHref } from "@/app/links";
import { IconButton } from "@/components/cockpit/icon-button";
import { MISSING } from "@/components/cockpit/table-columns";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { causeClassLabel } from "@/lib/cause-class";
import { formatRelativeTime, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { catalogLabel, LabelText } from "@/lib/machine-label";
import { cn } from "@/lib/utils";
import {
  asRuntime,
  authLabel,
  type ConnectorFigures,
  connectorCallsHref,
  connectorFigures,
  connectorStatsEndpoint,
  connectorStatsWindow,
  docKindLabel,
  documentationLinks,
  driverLabel,
  environmentLabel,
  type McpInspect,
  mcpTransport,
  toolsWithoutConfirmation,
  transportLabel,
} from "@/pages/connector-detail-model";

type RecordValue = Record<string, unknown>;

function text(record: RecordValue, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}

/** Puts a value on the clipboard and says so. */
function CopyButton({ value, label, testId }: { value: string; label: string; testId: string }) {
  const { t } = useI18n();
  return (
    <IconButton
      label={label}
      className="shrink-0"
      onClick={() =>
        void navigator.clipboard
          .writeText(value)
          .then(() => toast.success(t("connectorDetail.copied")))
      }
      data-testid={testId}
    >
      <Copy />
    </IconButton>
  );
}

function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-background p-4" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm font-medium">{children}</dd>
    </div>
  );
}

/**
 * "Verbindung": where the connector points and how it talks — the address
 * (copyable, never truncated), what kind of system it is, how it signs in.
 * Every value is a word from the label maps; an engine value this build has no
 * word for is shown as "Andere (<wert>)", never as a bare machine string.
 */
export function ConnectorConnectionFacts({
  record,
  headerNames,
}: {
  record: RecordValue;
  headerNames: readonly string[];
}) {
  const { t } = useI18n();
  const driver = text(record, "driver");
  const address = text(record, "base_url");
  const environment = text(record, "environment");
  const template = text(record, "template_name");
  const docs = documentationLinks(record);
  return (
    <section className="grid gap-2" data-testid="connector-connection-facts">
      <h2 className="text-sm font-semibold">{t("connectorDetail.connection.title")}</h2>
      <dl className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 sm:[&>:last-child:nth-child(odd)]:col-span-2">
        <Fact label={t("connectorDetail.connection.address")} testId="connector-fact-address">
          {address ? (
            <span className="flex min-w-0 items-start gap-1">
              <span className="min-w-0 break-all font-mono text-xs leading-6">{address}</span>
              <CopyButton
                value={address}
                label={t("connectorDetail.copyAddress")}
                testId="connector-copy-address"
              />
            </span>
          ) : (
            MISSING
          )}
        </Fact>
        <Fact label={t("connectorDetail.connection.kind")} testId="connector-fact-kind">
          {driverLabel(driver, t) || MISSING}
        </Fact>
        {driver === "mcp" ? (
          <Fact label={t("connectorDetail.connection.transport")} testId="connector-fact-transport">
            {transportLabel(mcpTransport(record) ?? "http", t)}
          </Fact>
        ) : null}
        <Fact
          label={t("connectorDetail.connection.environment")}
          testId="connector-fact-environment"
        >
          {environment ? (
            <Badge variant={environment === "prod" ? "secondary" : "outline"}>
              {environmentLabel(environment, t)}
            </Badge>
          ) : (
            MISSING
          )}
        </Fact>
        <Fact label={t("connectorDetail.connection.signIn")} testId="connector-fact-sign-in">
          {authLabel(text(record, "auth_type"), headerNames, t) || MISSING}
        </Fact>
        {template ? (
          <Fact label={t("connectorDetail.connection.template")} testId="connector-fact-template">
            {template}
          </Fact>
        ) : null}
        {docs.length > 0 ? (
          <Fact label={t("connectorDetail.connection.docs")} testId="connector-fact-docs">
            <ul className="grid gap-1">
              {docs.map((doc, index) => (
                <li key={`${doc.kind}:${doc.url}`}>
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                    data-testid={`connector-doc-${index}`}
                  >
                    <LabelText label={docKindLabel(doc.kind, t)} />
                  </a>
                </li>
              ))}
            </ul>
          </Fact>
        ) : null}
      </dl>
    </section>
  );
}

function Tile({
  label,
  testId,
  href,
  state,
  children,
}: {
  label: string;
  testId: string;
  href?: string | null;
  state?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="grid min-h-[72px] min-w-0 content-center gap-0.5 rounded-lg border px-3 py-2"
      data-testid={testId}
      data-figure-state={state ?? "value"}
    >
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      {href ? (
        <a
          href={absolute(href)}
          className="truncate text-lg font-semibold underline-offset-4 hover:underline"
          data-testid={`${testId}-link`}
        >
          {children}
        </a>
      ) : (
        <p className={state ? "text-sm text-muted-foreground" : "truncate text-lg font-semibold"}>
          {children}
        </p>
      )}
    </div>
  );
}

/**
 * "Laufzeit · letzte 7 Tage": calls, success rate, median response time and
 * the last success, read over ONE window fixed when the page opened; each
 * count leads to the audit log narrowed to the same connector and the same
 * window (§10.1), and a counted zero leads nowhere. The last failure is its
 * cause class in the cockpit's words — never the remote's text.
 */
export function ConnectorRuntimeSection({
  connectorId,
  driver,
  canReadStats,
  onTest,
}: {
  connectorId: string;
  driver: string | null;
  canReadStats: boolean;
  onTest: (() => void) | null;
}) {
  const { t, locale } = useI18n();
  const [bounds] = useState(() => connectorStatsWindow());
  const runtime = useQuery({
    queryKey: ["connector-runtime", connectorId],
    queryFn: () => apiRequest<unknown>(`/v1/connectors/${encodeURIComponent(connectorId)}/runtime`),
  });
  const stats = useQuery({
    queryKey: ["connector-stats", connectorId, bounds.from],
    enabled: canReadStats,
    queryFn: () => apiRequest<unknown>(connectorStatsEndpoint(connectorId, bounds)),
  });
  const runtimeView = queryView(runtime, (data) => asRuntime(data) === null);
  const statsView = queryView(stats, (data) => connectorFigures(data, bounds) === null);
  const title = <h2 className="text-sm font-semibold">{t("connectorDetail.runtime.title")}</h2>;

  if (runtimeView === "loading" || (canReadStats && statsView === "loading"))
    return (
      <section className="grid gap-2" data-testid="connector-runtime">
        {title}
        <Skeleton className="h-[72px] w-full" />
      </section>
    );
  // A body that is not a runtime answer is a failed read, not an empty one.
  const data = asRuntime(runtime.data);
  if (runtimeView !== "ready" || !data || (canReadStats && statsView !== "ready"))
    return (
      <section className="grid gap-2" data-testid="connector-runtime">
        {title}
        <LoadFailed
          title={t("connectorDetail.runtime.loadFailed")}
          onRetry={() => {
            void runtime.refetch();
            if (canReadStats) void stats.refetch();
          }}
          testId="connector-runtime-failed"
        />
      </section>
    );
  if (!data.recorded)
    return (
      <section className="grid gap-2" data-testid="connector-runtime">
        {title}
        <p className="text-sm text-muted-foreground" data-testid="connector-runtime-not-recorded">
          {t("connectorDetail.runtime.notRecorded")}
        </p>
      </section>
    );

  const figures: ConnectorFigures | null = canReadStats
    ? connectorFigures(stats.data, bounds)
    : null;
  const tag = locale === "de" ? "de-DE" : "en-US";
  const number = (value: number) => new Intl.NumberFormat(tag).format(value);
  const denied = t("connectorDetail.runtime.notPermitted");
  const failure = data.last_failure;
  return (
    <section className="grid gap-2" data-testid="connector-runtime">
      {title}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          label={t("connectorDetail.runtime.calls")}
          testId="connector-figure-calls"
          href={figures ? connectorCallsHref(connectorId, driver, figures, "all") : null}
          {...(figures ? {} : { state: "not_permitted" })}
        >
          {figures ? number(figures.calls) : denied}
        </Tile>
        <Tile
          label={t("connectorDetail.runtime.successRate")}
          testId="connector-figure-success"
          href={figures ? connectorCallsHref(connectorId, driver, figures, "failed") : null}
          {...(!figures
            ? { state: "not_permitted" }
            : figures.successRate === null
              ? { state: "none" }
              : {})}
        >
          {!figures
            ? denied
            : figures.successRate === null
              ? t("connectorDetail.runtime.noRate")
              : `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(figures.successRate)} %`}
        </Tile>
        <Tile
          label={t("connectorDetail.runtime.median")}
          testId="connector-figure-median"
          {...(!figures
            ? { state: "not_permitted" }
            : figures.medianMs === null
              ? { state: "none" }
              : {})}
        >
          {!figures
            ? denied
            : figures.medianMs === null
              ? t("connectorDetail.runtime.noLatency")
              : t("connectorDetail.runtime.ms", { ms: number(figures.medianMs) })}
        </Tile>
        <Tile
          label={t("connectorDetail.runtime.lastSuccess")}
          testId="connector-figure-last-success"
          {...(data.last_success_at ? {} : { state: "none" })}
        >
          {data.last_success_at
            ? formatRelativeTime(locale, data.last_success_at)
            : t("connectorDetail.runtime.never")}
        </Tile>
      </div>
      {figures && figures.calls === 0 ? (
        <p
          className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground"
          data-testid="connector-runtime-unused"
        >
          <span>{t("connectorDetail.runtime.unused")}</span>
          {onTest ? (
            <>
              <span aria-hidden="true">·</span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={onTest}
                data-testid="connector-runtime-test"
              >
                {t("detail.test")}
              </Button>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="text-sm" data-testid="connector-last-failure">
        <span className="text-muted-foreground">{t("connectorDetail.runtime.lastFailure")}: </span>
        {failure ? (
          <>
            {formatRelativeTime(locale, failure.at)} ·{" "}
            <LabelText label={causeClassLabel(failure.cause_class, t)} />
          </>
        ) : (
          t("connectorDetail.runtime.noFailure")
        )}
      </p>
    </section>
  );
}

const CAPABILITY_KEYS: Record<string, TranslationKey> = {
  tools: "connectorLabel.capability.tools",
  resources: "connectorLabel.capability.resources",
  prompts: "connectorLabel.capability.prompts",
  logging: "connectorLabel.capability.logging",
  completions: "connectorLabel.capability.completions",
};

interface ToolRow {
  name: string;
  description: string | null;
  claims: "read" | "write" | null;
}

/**
 * "Werkzeuge des Servers": what the negotiated session says about the server,
 * and its tools with the operator's one decision per tool — "Ohne Rückfrage".
 * The list comes from "Verbindung testen" (no handshake on page open); tools
 * already marked "Ohne Rückfrage" show before that, from the connector itself.
 * What the server CLAIMS about a tool is a badge, never a switch: the gate
 * ignores it, and so does this page.
 */
export function ConnectorMcpTools({
  connectorId,
  record,
  canWrite,
  inspect,
}: {
  connectorId: string;
  record: RecordValue;
  canWrite: boolean;
  inspect: { data: McpInspect | null; pending: boolean; failed: boolean };
}) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const trusted = toolsWithoutConfirmation(record);
  const runtime = useQuery({
    queryKey: ["connector-runtime", connectorId],
    queryFn: () => apiRequest<unknown>(`/v1/connectors/${encodeURIComponent(connectorId)}/runtime`),
  });
  const session = asRuntime(runtime.data)?.mcp_session ?? null;
  const setTrust = useMutation({
    mutationFn: (body: { tool: string; confirm: boolean }) =>
      apiRequest<unknown>(
        `/v1/connectors/${encodeURIComponent(connectorId)}/mcp/tool-confirmation`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", connectorId] });
    },
    onError: () => toast.error(t("connectorDetail.tools.saveFailed")),
  });

  const listed: ToolRow[] = inspect.data
    ? inspect.data.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? null,
        claims: tool.claims ?? null,
      }))
    : [];
  const known = new Set(listed.map((row) => row.name));
  const rows = [
    ...listed,
    ...trusted
      .filter((name) => !known.has(name))
      .map((name) => ({ name, description: null, claims: null })),
  ];

  return (
    <section className="grid gap-3" data-testid="connector-mcp-tools">
      <h2 className="text-sm font-semibold">{t("connectorDetail.tools.title")}</h2>
      <dl className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
        <Fact label={t("connectorDetail.tools.protocol")} testId="connector-mcp-protocol">
          {session?.protocol_version ? (
            <span className="font-mono text-xs">{session.protocol_version}</span>
          ) : (
            t("connectorDetail.tools.noSession")
          )}
        </Fact>
        <Fact label={t("connectorDetail.tools.capabilities")} testId="connector-mcp-capabilities">
          {session && session.capabilities.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {session.capabilities.map((key) => (
                <Badge key={key} variant="outline">
                  <LabelText label={catalogLabel(key, CAPABILITY_KEYS[key], t)} />
                </Badge>
              ))}
            </span>
          ) : (
            MISSING
          )}
        </Fact>
        <Fact label={t("connectorDetail.tools.lastContact")} testId="connector-mcp-last-contact">
          {session?.last_handshake_at
            ? formatRelativeTime(locale, session.last_handshake_at)
            : t("connectorDetail.tools.noSession")}
        </Fact>
      </dl>
      <p className="text-sm text-muted-foreground" data-testid="connector-mcp-note">
        {t("connectorDetail.tools.note")}
      </p>
      {inspect.pending ? <Skeleton className="h-16 w-full" /> : null}
      {inspect.failed ? (
        <p className="text-sm text-destructive" data-testid="connector-mcp-inspect-failed">
          {t("connectorDetail.tools.inspectFailed")}
        </p>
      ) : null}
      {inspect.data && inspect.data.tools.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="connector-mcp-no-tools">
          {t("connectorDetail.tools.none")}
        </p>
      ) : null}
      {!inspect.data && !inspect.pending && !inspect.failed ? (
        <p className="text-sm text-muted-foreground" data-testid="connector-mcp-load-hint">
          {t("connectorDetail.tools.loadHint")}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="grid gap-px overflow-hidden rounded-xl border bg-border">
          {rows.map((row, index) => {
            const checked = trusted.includes(row.name);
            const switchId = `connector-mcp-tool-${index}-trust`;
            return (
              <li
                key={row.name}
                className="flex flex-wrap items-start justify-between gap-3 bg-background p-3"
                data-testid={`connector-mcp-tool-${index}`}
              >
                <div className="grid min-w-0 flex-1 gap-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm">{row.name}</span>
                    {row.claims ? (
                      <Badge variant={row.claims === "write" ? "destructive" : "outline"}>
                        {t(
                          row.claims === "write"
                            ? "connectorDetail.tools.claimsWrite"
                            : "connectorDetail.tools.claimsRead",
                        )}
                      </Badge>
                    ) : null}
                  </span>
                  {row.description ? <ToolDescription text={row.description} /> : null}
                </div>
                <label htmlFor={switchId} className="flex shrink-0 items-center gap-2 text-sm">
                  <Switch
                    id={switchId}
                    checked={checked}
                    disabled={!canWrite || setTrust.isPending}
                    onCheckedChange={(next) =>
                      setTrust.mutate({ tool: row.name, confirm: next !== true })
                    }
                    data-testid={`connector-mcp-tool-${index}-trust`}
                  />
                  {t("connectorDetail.tools.withoutAsking")}
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

interface WorkflowList {
  items?: Array<{ id: string; name?: string | null; description?: string | null }>;
}

/** The workflows whose current version uses this connector, and the way to all of them. */
export function ConnectorWorkflows({ slug }: { slug: string }) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["connector-workflows", slug],
    queryFn: () =>
      apiRequest<WorkflowList>(`/v1/workflows?connector=${encodeURIComponent(slug)}&limit=20`),
  });
  const view = queryView(query, (data) => (data.items ?? []).length === 0);
  return (
    <section className="grid gap-2" data-testid="connector-workflows">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("connectorDetail.usage.title")}</h2>
        {/* A link to an empty list promises something that is not there. */}
        {view === "ready" ? (
          <a
            href={absolute(workflowsHref({ connector: slug }))}
            className="text-sm underline underline-offset-4"
            data-testid="connector-all-workflows"
          >
            {t("connectorDetail.usage.allWorkflows")}
          </a>
        ) : null}
      </div>
      {view === "loading" ? (
        <Skeleton className="h-12 w-full" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("connectorDetail.usage.workflowsFailed")}
          onRetry={() => void query.refetch()}
          testId="connector-workflows-failed"
        />
      ) : view === "empty" ? (
        <p className="text-sm text-muted-foreground" data-testid="connector-workflows-empty">
          {t("connectorDetail.usage.noWorkflows")}
        </p>
      ) : (
        <ul className="grid gap-1">
          {(query.data?.items ?? []).map((workflow, index) => (
            <li key={workflow.id}>
              <a
                href={absolute(workflowHref(workflow.id))}
                className="block min-w-0 truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                data-testid={`connector-workflow-${index}`}
              >
                {workflow.name || MISSING}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "Technische Angaben", folded: what someone quoting the connector to
 * operations needs — its short name, when it was made and changed, and its
 * identifier — one disclosure deeper than everything a reader decides by.
 */
export function ConnectorTechnicalFacts({ record, id }: { record: RecordValue; id: string }) {
  const { t, dateTime } = useI18n();
  const slug = text(record, "slug");
  const created = text(record, "created_at");
  const updated = text(record, "updated_at");
  return (
    <Collapsible data-testid="connector-technical">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
          data-testid="connector-technical-toggle"
        >
          <ChevronRight data-icon="inline-start" />
          {t("connectorDetail.technical.title")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-2 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 sm:[&>:last-child:nth-child(odd)]:col-span-2">
          <Fact label={t("resource.field.slug")} testId="connector-technical-slug">
            {slug ? <span className="break-all font-mono text-xs">{slug}</span> : MISSING}
          </Fact>
          <Fact label={t("resource.field.createdAt")} testId="connector-technical-created">
            {created ? dateTime(created) : MISSING}
          </Fact>
          <Fact label={t("catalog.updated")} testId="connector-technical-updated">
            {updated ? dateTime(updated) : MISSING}
          </Fact>
          <Fact label={t("connectorDetail.technical.id")} testId="connector-technical-id">
            <span className="flex min-w-0 items-start gap-1">
              <span className="min-w-0 break-all font-mono text-xs leading-6">{id}</span>
              <CopyButton
                value={id}
                label={t("connectorDetail.technical.copyId")}
                testId="connector-copy-id"
              />
            </span>
          </Fact>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A server's tool text can run to a page of its own; two lines, the rest on request. */
function ToolDescription({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || text.includes("\n");
  return (
    <div className="grid justify-items-start gap-0.5">
      <p
        className={cn(
          "whitespace-pre-line break-words text-sm text-muted-foreground",
          !open && "line-clamp-2",
        )}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          className="text-xs underline underline-offset-4"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-testid="connector-mcp-tool-description-toggle"
        >
          {t(open ? "connectorDetail.tools.less" : "connectorDetail.tools.more")}
        </button>
      ) : null}
    </div>
  );
}
