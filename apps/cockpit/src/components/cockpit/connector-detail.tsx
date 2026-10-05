import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  ContextHelp,
  CopyField,
  DataState,
  type Fact,
  FactList,
  RecordSheet,
  SegmentedControl,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { causeClassLabel } from "@/lib/cause-class";
import { formatRelativeTime, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { catalogLabel, LabelText } from "@/lib/machine-label";
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
  presentAddress,
  toolsWithoutConfirmation,
  transportLabel,
} from "@/pages/connector-detail-model";
import { triggerLabelKey } from "@/pages/workflows-model";

type RecordValue = Record<string, unknown>;

function text(record: RecordValue, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}

function Copyable({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0" data-action-scope="copy">
      {children}
    </div>
  );
}

export function ConnectorConnectionFacts({
  record,
  headerNames,
}: {
  record: RecordValue;
  headerNames: readonly string[];
}) {
  const { t } = useI18n();
  const driver = text(record, "driver");
  const stored = text(record, "base_url");
  const address = stored ? presentAddress(stored) : null;
  const environment = text(record, "environment");
  const template = text(record, "template_name");
  const docs = documentationLinks(record);
  const facts: Fact[] = [
    {
      label: t("connectorDetail.connection.address"),
      value: address ? (
        address.keepsSecret ? (
          <span className="break-all font-mono text-xs">{address.shown}</span>
        ) : (
          <Copyable>
            <CopyField
              value={address.shown}
              label={t("connectorDetail.copyAddress")}
              testId="connector-copy-address"
            />
          </Copyable>
        )
      ) : (
        MISSING
      ),
      ...(address?.keepsSecret ? { help: t("connectorDetail.connection.secretKept") } : {}),
      testId: "connector-fact-address",
    },
    {
      label: t("connectorDetail.connection.kind"),
      value: driverLabel(driver, t) || MISSING,
      testId: "connector-fact-kind",
    },
    ...(driver === "mcp"
      ? [
          {
            label: t("connectorDetail.connection.transport"),
            value: transportLabel(mcpTransport(record) ?? "http", t),
            testId: "connector-fact-transport",
          },
        ]
      : []),
    {
      label: t("connectorDetail.connection.environment"),
      value: environment ? environmentLabel(environment, t) : MISSING,
      testId: "connector-fact-environment",
    },
    {
      label: t("connectorDetail.connection.signIn"),
      value: authLabel(text(record, "auth_type"), headerNames, t) || MISSING,
      testId: "connector-fact-sign-in",
    },
    ...(template
      ? [
          {
            label: t("connectorDetail.connection.template"),
            value: template,
            testId: "connector-fact-template",
          },
        ]
      : []),
    ...(docs.length > 0
      ? [
          {
            label: t("connectorDetail.connection.docs"),
            value: (
              <span className="flex flex-col gap-1">
                {docs.map((doc, index) => (
                  <a
                    key={`${doc.kind}:${doc.url}`}
                    href={doc.url}
                    target="_blank"
                    rel="noreferrer"
                    className="w-fit underline underline-offset-4"
                    data-testid={`connector-doc-${index}`}
                  >
                    <LabelText label={docKindLabel(doc.kind, t)} />
                  </a>
                ))}
              </span>
            ),
            testId: "connector-fact-docs",
          },
        ]
      : []),
  ];
  return (
    <div data-testid="connector-connection-facts">
      <FactList items={facts} />
    </div>
  );
}

export function ConnectorRuntimeSection({
  connectorId,
  driver,
  canReadStats,
}: {
  connectorId: string;
  driver: string | null;
  canReadStats: boolean;
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
  if (runtime.isPending || (canReadStats && stats.isPending))
    return <DataState state="loading" testId="connector-runtime" />;
  const data = asRuntime(runtime.data);
  const figures: ConnectorFigures | null = canReadStats
    ? connectorFigures(stats.data, bounds)
    : null;
  if (!data || runtime.error || (canReadStats && (stats.error || !figures)))
    return (
      <div data-testid="connector-runtime">
        <DataState
          state="error"
          line={t("connectorDetail.runtime.loadFailed")}
          onRetry={() => {
            void runtime.refetch();
            if (canReadStats) void stats.refetch();
          }}
          testId="connector-runtime-failed"
        />
      </div>
    );
  const muted = "text-sm text-muted-foreground";
  if (!data.recorded)
    return (
      <div data-testid="connector-runtime">
        <p className={muted} data-testid="connector-runtime-not-recorded">
          {t("connectorDetail.runtime.notRecorded")}
        </p>
      </div>
    );
  const tag = locale === "de" ? "de-DE" : "en-US";
  const number = (value: number) => new Intl.NumberFormat(tag).format(value);
  const failure = data.last_failure;
  const lastSuccess = data.last_success_at
    ? formatRelativeTime(locale, data.last_success_at)
    : null;
  const link = (href: string | null, label: string, testId: string) =>
    href ? (
      <a
        href={absolute(href)}
        className="font-medium underline-offset-4 hover:underline"
        data-testid={`${testId}-link`}
      >
        {label}
      </a>
    ) : (
      label
    );
  const facts: Fact[] =
    !figures || figures.calls === 0
      ? [
          {
            label: t("connectorDetail.runtime.lastSuccess"),
            value: lastSuccess ?? t("connectorDetail.runtime.never"),
            testId: "connector-last-success",
          },
        ]
      : [
          {
            label: t("connectorDetail.runtime.calls"),
            value: link(
              connectorCallsHref(connectorId, driver, figures, "all"),
              number(figures.calls),
              "connector-figure-calls",
            ),
            testId: "connector-figure-calls",
          },
          {
            label: t("connectorDetail.runtime.successRate"),
            value:
              figures.successRate === null
                ? t("connectorDetail.runtime.noRate")
                : link(
                    connectorCallsHref(connectorId, driver, figures, "failed"),
                    `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(figures.successRate)} %`,
                    "connector-figure-success",
                  ),
            testId: "connector-figure-success",
          },
          {
            label: t("connectorDetail.runtime.median"),
            value:
              figures.medianMs === null
                ? t("connectorDetail.runtime.noLatency")
                : t("connectorDetail.runtime.ms", { ms: number(figures.medianMs) }),
            testId: "connector-figure-median",
          },
          {
            label: t("connectorDetail.runtime.lastSuccess"),
            value: lastSuccess ?? t("connectorDetail.runtime.never"),
            testId: "connector-figure-last-success",
          },
        ];
  return (
    <div className="flex flex-col gap-3" data-testid="connector-runtime">
      {!figures || figures.calls === 0 ? (
        <p
          className={muted}
          data-testid={figures ? "connector-runtime-unused" : "connector-runtime-not-permitted"}
        >
          {t(
            figures
              ? "connectorDetail.runtime.unused"
              : "connectorDetail.runtime.figuresNotPermitted",
          )}
        </p>
      ) : null}
      <FactList
        items={[
          ...facts,
          ...(failure
            ? [
                {
                  label: t("connectorDetail.runtime.lastFailure"),
                  value: (
                    <>
                      {formatRelativeTime(locale, failure.at)} ·{" "}
                      <LabelText label={causeClassLabel(failure.cause_class, t)} />
                    </>
                  ),
                  testId: "connector-last-failure",
                },
              ]
            : []),
        ]}
      />
    </div>
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
  trusted: boolean;
}

function ToolSheet({
  row,
  index,
  canWrite,
  pending,
  onTrust,
  onClose,
}: {
  row: ToolRow;
  index: number;
  canWrite: boolean;
  pending: boolean;
  onTrust: (trusted: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <RecordSheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={<span className="break-all font-mono">{row.name}</span>}
      testId={`connector-mcp-tool-${index}-sheet`}
      closeTestId={`connector-mcp-tool-${index}-close`}
    >
      {row.description ? (
        <p className="whitespace-pre-line break-words text-sm text-muted-foreground">
          {row.description}
        </p>
      ) : null}
      <FactList
        items={[
          {
            label: t("connectorDetail.tools.claims"),
            value: row.claims
              ? t(
                  row.claims === "write"
                    ? "connectorDetail.tools.claimsWrite"
                    : "connectorDetail.tools.claimsRead",
                )
              : MISSING,
            help: t("connectorDetail.tools.claimsHelp"),
          },
        ]}
      />
      {canWrite ? (
        <SegmentedControl
          label={t("connectorDetail.tools.withoutAsking")}
          value={row.trusted ? "trusted" : "asks"}
          onValueChange={(value) => !pending && onTrust(value === "trusted")}
          testId={`connector-mcp-tool-${index}-trust`}
          options={[
            {
              value: "asks",
              label: t("connectorDetail.tools.asks"),
              testId: `connector-mcp-tool-${index}-asks`,
            },
            {
              value: "trusted",
              label: t("connectorDetail.tools.withoutAsking"),
              testId: `connector-mcp-tool-${index}-trusted`,
            },
          ]}
        />
      ) : null}
    </RecordSheet>
  );
}

export function ConnectorMcpTools({
  connectorId,
  record,
  canWrite,
  canTest,
  inspect,
  onInspect,
}: {
  connectorId: string;
  record: RecordValue;
  canWrite: boolean;
  canTest: boolean;
  inspect: { data: McpInspect | null; pending: boolean; failed: boolean };
  onInspect: () => void;
}) {
  const { t, locale, dateTime } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const trusted = toolsWithoutConfirmation(record);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !canTest || inspect.data || inspect.pending) return;
    asked.current = true;
    onInspect();
  }, [canTest, inspect.data, inspect.pending, onInspect]);
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
        trusted: trusted.includes(tool.name),
      }))
    : [];
  const known = new Set(listed.map((row) => row.name));
  const rows = [
    ...listed,
    ...trusted
      .filter((name) => !known.has(name))
      .map((name) => ({ name, description: null, claims: null, trusted: true })),
  ];
  const columns = useMemo<CockpitColumn<ToolRow>[]>(() => {
    const column = tableColumns<ToolRow>({ t, dateTime });
    return [
      column.custom(
        "name",
        (row) => row.name,
        t("connectorDetail.tools.name"),
        (row) => <span className="break-all font-mono text-xs">{row.name}</span>,
        { width: "w-[45%]" },
      ),
      column.custom(
        "claims",
        (row) => row.claims,
        t("connectorDetail.tools.claims"),
        (row) =>
          row.claims
            ? t(
                row.claims === "write"
                  ? "connectorDetail.tools.claimsWrite"
                  : "connectorDetail.tools.claimsRead",
              )
            : MISSING,
        { width: "w-[25%]" },
      ),
      column.custom(
        "trusted",
        (row) => row.trusted,
        t("connectorDetail.tools.confirmation"),
        (row) =>
          t(row.trusted ? "connectorDetail.tools.withoutAsking" : "connectorDetail.tools.asks"),
        { width: "w-[30%]" },
      ),
    ];
  }, [t, dateTime]);
  const sessionLine = session
    ? [
        session.capabilities
          .map((key) => catalogLabel(key, CAPABILITY_KEYS[key], t).text)
          .join(", "),
        session.last_handshake_at
          ? t("connectorDetail.tools.lastContactAt", {
              when: formatRelativeTime(locale, session.last_handshake_at),
            })
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : t("connectorDetail.tools.noSession");
  const selected = open === null ? null : (rows[open] ?? null);
  return (
    <div className="flex flex-col gap-3" data-testid="connector-mcp-tools">
      <SummaryLine
        text={
          <span className="inline-flex items-center gap-1">
            <span data-testid="connector-mcp-session">{sessionLine}</span>
            {session?.protocol_version ? (
              <ContextHelp
                label={t("connectorDetail.tools.protocol")}
                testId="connector-mcp-protocol"
              >
                {t("connectorDetail.tools.protocolVersion", { version: session.protocol_version })}
              </ContextHelp>
            ) : null}
          </span>
        }
        aside={
          canTest ? (
            <ActionMenu
              items={[
                {
                  label: t("connectorDetail.tools.reload"),
                  disabled: inspect.pending,
                  onSelect: onInspect,
                  testId: "connector-mcp-reload",
                },
              ]}
            />
          ) : undefined
        }
        testId="connector-mcp-summary"
      />
      {inspect.failed ? (
        <DataState
          state="error"
          line={t("connectorDetail.tools.inspectFailed")}
          testId="connector-mcp-inspect-failed"
        />
      ) : null}
      <RecordTable
        columns={columns}
        data={rows}
        collectionId="connector-mcp-tool"
        emptyLine={t(
          inspect.data ? "connectorDetail.tools.none" : "connectorDetail.tools.loadHint",
        )}
        pending={inspect.pending}
        onOpen={(row) => setOpen(rows.indexOf(row))}
        rowLabel={(row) => row.name}
      />
      {selected && open !== null ? (
        <ToolSheet
          row={selected}
          index={open}
          canWrite={canWrite}
          pending={setTrust.isPending}
          onTrust={(next) => setTrust.mutate({ tool: selected.name, confirm: !next })}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

type WorkflowListItem = components["schemas"]["WorkflowListItem"];

interface WorkflowItem {
  id: string;
  name?: string | null;
  effective_trigger?: WorkflowListItem["effective_trigger"];
  last_executed_at?: string | null;
}

export function useConnectorWorkflows(slug: string | null) {
  return useQuery({
    queryKey: ["connector-workflows", slug],
    queryFn: () =>
      apiRequest<{ items?: WorkflowItem[]; total?: number }>(
        `/v1/workflows?connector=${encodeURIComponent(slug ?? "")}&limit=50`,
      ),
    enabled: slug !== null,
  });
}

export function ConnectorWorkflows({ slug, connectorId }: { slug: string; connectorId: string }) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const { permissions } = useSession();
  const query = useConnectorWorkflows(slug);
  const rows = query.data?.items ?? [];
  const columns = useMemo<CockpitColumn<WorkflowItem>[]>(() => {
    const column = tableColumns<WorkflowItem>({ t, dateTime });
    return [
      column.text("name", (row) => row.name, t("runs.column.workflow"), { width: "w-[50%]" }),
      column.custom(
        "trigger",
        (row) => row.effective_trigger,
        t("catalog.trigger"),
        (row) => (row.effective_trigger ? t(triggerLabelKey(row.effective_trigger)) : MISSING),
        { width: "w-[25%]" },
      ),
      column.date("last_executed_at", (row) => row.last_executed_at, t("catalog.lastRun"), {
        width: "w-[25%]",
      }),
    ];
  }, [t, dateTime]);
  const count = query.data?.total ?? rows.length;
  return (
    <>
      <SummaryLine
        text={
          query.data
            ? t(count === 1 ? "connectorPage.usedBy.one" : "connectorPage.usedBy.other", {
                count,
              })
            : t("connectorDetail.usage.title")
        }
        testId="connector-usage-summary"
      />
      <div data-testid="connector-workflows">
        <RecordTable
          columns={columns}
          data={rows}
          collectionId="connector-workflow"
          emptyLine={t("connectorDetail.usage.noWorkflows")}
          emptyAction={
            permissions.includes("conversation:write") ? (
              <Button asChild variant="outline" size="sm">
                <a
                  href={absolute(chatNewHref({ prompt: t("create.workflow.prompt"), connectorId }))}
                  data-testid="connector-workflows-create"
                >
                  {t("connectorDetail.usage.createInChat")}
                </a>
              </Button>
            ) : undefined
          }
          pending={query.isPending}
          error={
            query.error
              ? {
                  line: t("connectorDetail.usage.workflowsFailed"),
                  onRetry: () => void query.refetch(),
                }
              : null
          }
          onOpen={(row) => void navigate({ to: workflowHref(row.id) })}
          rowHref={(row) => workflowHref(row.id)}
        />
      </div>
    </>
  );
}

export function ConnectorTechnicalFacts({ record, id }: { record: RecordValue; id: string }) {
  const { t, dateTime } = useI18n();
  const slug = text(record, "slug");
  const created = text(record, "created_at");
  const updated = text(record, "updated_at");
  return (
    <FactList
      items={[
        {
          label: t("resource.field.slug"),
          value: slug ? <span className="break-all font-mono text-xs">{slug}</span> : MISSING,
          testId: "connector-technical-slug",
        },
        {
          label: t("resource.field.createdAt"),
          value: created ? dateTime(created) : MISSING,
          testId: "connector-technical-created",
        },
        {
          label: t("catalog.updated"),
          value: updated ? dateTime(updated) : MISSING,
          testId: "connector-technical-updated",
        },
        {
          label: t("connectorDetail.technical.id"),
          value: (
            <Copyable>
              <CopyField
                value={id}
                label={t("connectorDetail.technical.copyId")}
                testId="connector-copy-id"
              />
            </Copyable>
          ),
          testId: "connector-technical-id",
        },
      ]}
    />
  );
}
