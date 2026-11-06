import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Hand, RefreshCw, Workflow, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { absolute, chatNewHref, workflowAutomationHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import { CreateAction } from "@/components/cockpit/create-choice";
import {
  Button,
  Chip,
  CodeBlock,
  CopyField,
  DataState,
  type Fact,
  FactList,
  FilterBar,
  IconTile,
  RecordSheet,
  SectionHeading,
  StatusBadge,
  SummaryLine,
  Switch,
  TabBody,
  TechnicalDetails,
  TemplateCard,
  TemplateGrid,
} from "@/components/cockpit/patterns";
import { ServiceIcon } from "@/components/cockpit/service-icon";
import { MISSING } from "@/components/cockpit/table-columns";
import { humanize } from "@/lib/effect-label";
import { formatRelativeTime, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { catalogLabel, LabelText } from "@/lib/machine-label";
import { schemaFieldKind, schemaFields } from "@/lib/schema-form";
import type { ServiceIdentity } from "@/lib/service-icons";
import { useSearchParamState } from "@/lib/use-search-param-state";
import type { InputField } from "@/lib/workflow-inputs";
import { catalogOperatingStatus, OPERATING_STATUS_KEYS } from "@/pages/catalog-model";
import {
  asRuntime,
  authLabel,
  connectorConfiguredRuntime,
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
import { askingTools, toolTitle } from "./connector-view-model";
import type { ConnectorTemplate } from "./create-template-model";

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

export function ConnectorRuntimeSection({
  record,
  latencyMs,
}: {
  record: RecordValue;
  latencyMs: number | null;
}) {
  const { t } = useI18n();
  const runtime = connectorConfiguredRuntime(record);
  const unspecified = t("connectorDetail.runtime.notSpecified");
  const status = t(
    runtime.timeoutApplied
      ? "connectorDetail.runtime.effective"
      : "connectorDetail.runtime.notApplied",
  );
  const rateLimit = runtime.rateLimit;
  return (
    <FactList
      testId="connector-runtime"
      items={[
        ...(latencyMs !== null
          ? [
              {
                label: t("connectorPage.latency"),
                value: `${Math.round(latencyMs)} ms`,
                testId: "connector-runtime-latency",
              },
            ]
          : []),
        {
          label: t("connectorDetail.runtime.timeout"),
          value: runtime.timeout === null ? unspecified : `${runtime.timeout} ms · ${status}`,
          ...(runtime.timeout !== null && !runtime.timeoutApplied
            ? { help: t("connectorDetail.runtime.storedNotApplied") }
            : {}),
        },
        {
          label: t("connectorDetail.runtime.retries"),
          value:
            runtime.retries === null
              ? unspecified
              : `${runtime.retries} · ${t("connectorDetail.runtime.notApplied")}`,
          help:
            runtime.retries === null
              ? t("connectorDetail.runtime.workflowRetriesHelp")
              : `${t("connectorDetail.runtime.storedNotApplied")} ${t("connectorDetail.runtime.workflowRetriesHelp")}`,
        },
        {
          label: t("connectorDetail.runtime.rateLimit"),
          value: rateLimit
            ? `${t("connectorDetail.runtime.rateHint", { rate: rateLimit.requestsPerSecond, burst: rateLimit.burstSize, backoff: rateLimit.recommendedBackoffMs })} · ${t(rateLimit.source === "template" ? "connectorDetail.runtime.templateHint" : "connectorDetail.runtime.providerHint")}`
            : unspecified,
          help: t("connectorDetail.runtime.rateHintHelp"),
        },
      ]}
    />
  );
}

export function ConnectorTechnicalFacts({
  record,
  id,
  headerNames,
  speaksAs,
}: {
  record: RecordValue;
  id: string;
  headerNames: readonly string[];
  speaksAs?: { issuer: string; subject: string } | null;
}) {
  const { t, dateTime } = useI18n();
  const driver = text(record, "driver");
  const stored = text(record, "base_url");
  const address = stored ? presentAddress(stored) : null;
  const template = text(record, "template_name");
  const slug = text(record, "slug");
  const created = text(record, "created_at");
  const updated = text(record, "updated_at");
  const docs = documentationLinks(record);
  const items: Fact[] = [
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
      label: t("connectorDetail.connection.signIn"),
      value: authLabel(text(record, "auth_type"), headerNames, t) || MISSING,
      testId: "connector-fact-sign-in",
    },
    ...(speaksAs
      ? [
          {
            label: t("connectorDetail.connection.speaksAs"),
            value: `${speaksAs.subject} · ${speaksAs.issuer}`,
            testId: "connector-speaks-as",
          },
        ]
      : []),
    ...(template
      ? [
          {
            label: t("connectorDetail.connection.template"),
            value:
              typeof record.template_version === "number"
                ? `${template} · ${t("connectorPage.templateVersion", { version: record.template_version })}`
                : template,
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
    ...(slug
      ? [
          {
            label: t("resource.field.slug"),
            value: <span className="break-all font-mono text-xs">{slug}</span>,
            testId: "connector-technical-slug",
          },
        ]
      : []),
    ...(created
      ? [
          {
            label: t("resource.field.createdAt"),
            value: dateTime(created),
            testId: "connector-technical-created",
          },
        ]
      : []),
    ...(updated
      ? [
          {
            label: t("catalog.updated"),
            value: dateTime(updated),
            testId: "connector-technical-updated",
          },
        ]
      : []),
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
  ];
  return <FactList items={items} testId="connector-technical-facts" />;
}

export function environmentName(record: RecordValue, t: ReturnType<typeof useI18n>["t"]) {
  return environmentLabel(text(record, "environment"), t);
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
  title: string;
  description: string | null;
  claims: "read" | "write" | null;
  trusted: boolean;
  inputSchema: Record<string, unknown> | null;
}

function fieldLine(field: InputField, t: ReturnType<typeof useI18n>["t"]): string {
  const kind = schemaFieldKind(field);
  const shape =
    kind === "enum"
      ? t("connectorPage.tools.input.enum", {
          options: (field.options ?? []).map((option) => String(option)).join(", "),
        })
      : t(
          (
            {
              text: "connectorPage.tools.input.text",
              number: "connectorPage.tools.input.number",
              boolean: "connectorPage.tools.input.boolean",
              group: "connectorPage.tools.input.group",
              list: "connectorPage.tools.input.list",
              json: "connectorPage.tools.input.json",
            } as const
          )[kind],
        );
  return `${shape} · ${t(field.required ? "connectorPage.tools.input.required" : "connectorPage.tools.input.optional")}`;
}

function ToolSheet({
  row,
  canWrite,
  pending,
  onAsk,
  onClose,
}: {
  row: ToolRow;
  canWrite: boolean;
  pending: boolean;
  onAsk: (asks: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fields = schemaFields(row.inputSchema);
  return (
    <RecordSheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={row.title}
      subtitle={t("connectorPage.tools.sheetSubtitle")}
      testId="connector-mcp-tool-sheet"
      closeTestId="connector-mcp-tool-close"
    >
      <div className="flex flex-col gap-5">
        {row.description ? (
          <p className="whitespace-pre-line break-words text-sm">{row.description}</p>
        ) : null}
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
          <span>
            <span className="block font-medium">{t("connectorPage.tools.askFirst")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("connectorPage.tools.askFirstLine")}
            </span>
          </span>
          <Switch
            checked={!row.trusted}
            disabled={!canWrite || pending}
            onCheckedChange={(checked) => onAsk(checked)}
            aria-label={t("connectorPage.tools.askFirst")}
            data-testid="connector-mcp-tool-ask"
          />
        </div>
        <section className="flex flex-col gap-2">
          <SectionHeading>{t("connectorPage.tools.inputs")}</SectionHeading>
          {fields.length > 0 ? (
            <FactList
              testId="connector-mcp-tool-inputs"
              items={fields.map((field) => ({
                label: field.title ?? humanize(field.name),
                value: fieldLine(field, t),
                ...(field.description ? { help: field.description } : {}),
              }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("connectorPage.tools.noInputs")}</p>
          )}
        </section>
        {row.claims ? (
          <FactList
            items={[
              {
                label: t("connectorDetail.tools.claims"),
                value: t(
                  row.claims === "write"
                    ? "connectorDetail.tools.claimsWrite"
                    : "connectorDetail.tools.claimsRead",
                ),
                help: t("connectorDetail.tools.claimsHelp"),
              },
            ]}
          />
        ) : null}
        <TechnicalDetails testId="connector-mcp-tool-technical">
          <FactList
            items={[
              {
                label: t("connectorPage.tools.serverName"),
                value: <span className="break-all font-mono text-xs">{row.name}</span>,
              },
            ]}
          />
          <CodeBlock
            label={t("connectorDetail.tools.inputSchema")}
            code={row.inputSchema ? JSON.stringify(row.inputSchema, null, 2) : MISSING}
            lang="json"
            testId="connector-tool-input-schema"
          />
        </TechnicalDetails>
      </div>
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
  inspect: { data: McpInspect | null; pending: boolean; failed: boolean; readAt?: string | null };
  onInspect: () => void;
}) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = useSearchParamState("tool", "");
  const [search, setSearch] = useState("");
  const trusted = toolsWithoutConfirmation(record);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !canTest || inspect.data || inspect.pending) return;
    asked.current = true;
    onInspect();
  }, [canTest, inspect.data, inspect.pending, onInspect]);
  const runtime = useQuery({
    queryKey: ["connector-runtime", connectorId],
    queryFn: () => apiCall("get", "/v1/connectors/{id}/runtime", { path: { id: connectorId } }),
  });
  const session = asRuntime(runtime.data)?.mcp_session ?? null;
  const setAsk = useMutation({
    mutationFn: (body: { tool: string; confirm: boolean }) =>
      apiCall("put", "/v1/connectors/{id}/mcp/tool-confirmation", {
        path: { id: connectorId },
        body,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", connectorId] });
    },
    onError: () => toast.error(t("connectorDetail.tools.saveFailed")),
  });
  const listed: ToolRow[] = inspect.data
    ? inspect.data.tools.map((tool) => ({
        name: tool.name,
        title: toolTitle(tool),
        description: tool.description ?? null,
        claims: tool.claims ?? null,
        trusted: trusted.includes(tool.name),
        inputSchema: tool.input_schema ?? null,
      }))
    : [];
  const known = new Set(listed.map((row) => row.name));
  const rows: ToolRow[] = [
    ...listed,
    ...trusted
      .filter((name) => !known.has(name))
      .map((name) => ({
        name,
        title: toolTitle({ name }),
        description: null,
        claims: null,
        trusted: true,
        inputSchema: null,
      })),
  ];
  const asks = askingTools(
    rows.map((row) => row.name),
    trusted,
  );
  const summary = inspect.data
    ? [
        t(
          rows.length === 1
            ? "connectorDetail.tools.count.one"
            : "connectorDetail.tools.count.other",
          { count: rows.length },
        ),
        t(asks === 1 ? "connectorPage.tools.asking.one" : "connectorPage.tools.asking.other", {
          count: asks,
        }),
        inspect.readAt
          ? t("connectorDetail.tools.readAt", { when: formatRelativeTime(locale, inspect.readAt) })
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : t(inspect.pending ? "connectorPage.tools.reading" : "connectorDetail.tools.loadHint");
  const selected = open ? (rows.find((row) => row.name === open) ?? null) : null;
  const needle = search.trim().toLocaleLowerCase();
  const shown = needle
    ? rows.filter((row) =>
        `${row.name} ${row.title} ${row.description ?? ""}`.toLocaleLowerCase().includes(needle),
      )
    : rows;
  const sessionFacts: Fact[] = session
    ? [
        ...(session.protocol_version
          ? [{ label: t("connectorDetail.tools.protocol"), value: session.protocol_version }]
          : []),
        ...(session.capabilities.length > 0
          ? [
              {
                label: t("connectorDetail.tools.capabilities"),
                value: session.capabilities
                  .map((key) => catalogLabel(key, CAPABILITY_KEYS[key], t).text)
                  .join(", "),
              },
            ]
          : []),
        ...(session.last_handshake_at
          ? [
              {
                label: t("connectorDetail.tools.lastContact"),
                value: formatRelativeTime(locale, session.last_handshake_at),
              },
            ]
          : []),
      ]
    : [];
  return (
    <TabBody
      testId="connector-mcp-tools"
      summary={
        <SummaryLine
          text={<span data-testid="connector-mcp-session">{summary}</span>}
          aside={
            canTest ? (
              <Button
                variant="outline"
                size="sm"
                disabled={inspect.pending}
                onClick={onInspect}
                data-testid="connector-mcp-reload"
              >
                <RefreshCw data-icon="inline-start" />
                {t("connectorDetail.tools.reload")}
              </Button>
            ) : undefined
          }
          testId="connector-mcp-summary"
        />
      }
      technical={sessionFacts.length > 0 ? <FactList items={sessionFacts} /> : undefined}
    >
      {inspect.failed ? (
        <DataState
          state="error"
          line={t("connectorDetail.tools.inspectFailed")}
          testId="connector-mcp-inspect-failed"
        />
      ) : null}
      {rows.length > 8 ? (
        <FilterBar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("connectorDetail.tools.search"),
            testId: "connector-tools-search",
          }}
        />
      ) : null}
      {shown.length > 0 ? (
        <ul
          className="flex flex-col divide-y rounded-lg border"
          data-testid="connector-mcp-tool-list"
        >
          {shown.map((row, index) => (
            <li key={row.name}>
              <button
                type="button"
                onClick={() => setOpen(row.name)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`connector-mcp-tool-${index}`}
              >
                <Wrench aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{row.title}</span>
                  {row.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.description}
                    </span>
                  ) : null}
                </span>
                <Chip
                  testId={`connector-mcp-tool-${index}-chip`}
                  data-asks={!row.trusted || undefined}
                >
                  {row.trusted ? null : <Hand aria-hidden="true" />}
                  {t(row.trusted ? "connectorPage.tools.free" : "connectorPage.tools.asks")}
                </Chip>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : inspect.pending ? null : (
        <p className="text-sm text-muted-foreground" data-testid="connector-mcp-tools-empty">
          {needle
            ? t("resource.noMatches")
            : t(inspect.data ? "connectorDetail.tools.none" : "connectorDetail.tools.loadHint")}
        </p>
      )}
      {selected ? (
        <ToolSheet
          row={selected}
          canWrite={canWrite}
          pending={setAsk.isPending}
          onAsk={(confirm) => setAsk.mutate({ tool: selected.name, confirm })}
          onClose={() => setOpen("")}
        />
      ) : null}
    </TabBody>
  );
}

type WorkflowItem = components["schemas"]["WorkflowListItem"];

export function useConnectorWorkflows(slug: string | null) {
  return useQuery({
    queryKey: ["connector-workflows", slug],
    queryFn: () => apiCall("get", "/v1/workflows", { query: { connector: slug ?? "", limit: 50 } }),

    enabled: slug !== null,
  });
}

function WorkflowCard({ row, index }: { row: WorkflowItem; index: number }) {
  const { t, locale } = useI18n();
  const status = catalogOperatingStatus(row.operating_status);
  const line = [
    row.effective_trigger ? t(triggerLabelKey(row.effective_trigger)) : null,
    row.last_executed_at
      ? t("connectorPage.usage.lastRun", { when: formatRelativeTime(locale, row.last_executed_at) })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const approved = row.authority_environments;
  return (
    <div
      className="relative flex min-w-0 items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50 focus-within:outline-none focus-within:ring-2 focus-within:ring-ring"
      data-testid={`connector-workflow-${index}`}
    >
      <IconTile>
        <Workflow />
      </IconTile>
      <span className="min-w-0 flex-1">
        <a
          href={absolute(workflowHref(row.id))}
          className="block truncate text-sm font-medium before:absolute before:inset-0"
          data-testid={`connector-workflow-${index}-link`}
        >
          {row.name || MISSING}
        </a>
        {line ? <span className="block truncate text-xs text-muted-foreground">{line}</span> : null}
        {approved ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span data-testid={`connector-workflow-${index}-approval-dev`}>
              {t(
                approved.dev?.ready_for_new_run
                  ? "connectorPage.usage.approvedDev"
                  : "connectorPage.usage.missingDev",
              )}
            </span>
            <span data-testid={`connector-workflow-${index}-approval-prod`}>
              {t(
                approved.prod?.ready_for_new_run
                  ? "connectorPage.usage.approvedProd"
                  : "connectorPage.usage.missingProd",
              )}
            </span>
            <a
              href={absolute(workflowAutomationHref(row.id))}
              className="relative z-10 text-accent underline-offset-4 hover:underline"
              data-testid={`connector-workflow-${index}-approval-link`}
            >
              {t("connectorPage.usage.openApproval")}
            </a>
          </span>
        ) : null}
      </span>
      <StatusBadge state={status} label={t(OPERATING_STATUS_KEYS[status])} />
    </div>
  );
}

export function ConnectorWorkflows({
  slug,
  connectorId,
  connectorName,
  service,
  template,
  conversations,
}: {
  slug: string;
  connectorId: string;
  connectorName: string;
  service: ServiceIdentity;
  template: ConnectorTemplate | null;
  conversations?: ReactNode;
}) {
  const { t } = useI18n();
  const { permissions } = useSession();
  const query = useConnectorWorkflows(slug);
  const rows = query.data?.items ?? [];
  const count = query.data?.total ?? rows.length;
  const canChat = permissions.includes("conversation:write");
  const canCreate = permissions.includes("workflow:write");
  const recipes = template?.recipes ?? [];
  return (
    <TabBody
      testId="connector-usage"
      summary={
        <SummaryLine
          loading={query.isPending}
          text={t(count === 1 ? "connectorPage.usedBy.one" : "connectorPage.usedBy.other", {
            count,
            name: connectorName,
          })}
          testId="connector-usage-summary"
        />
      }
      more={conversations}
    >
      <div data-testid="connector-workflows" className="flex flex-col gap-6">
        {query.error ? (
          <DataState
            state="error"
            line={t("connectorDetail.usage.workflowsFailed")}
            onRetry={() => void query.refetch()}
          />
        ) : query.isPending ? null : rows.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map((row, index) => (
              <WorkflowCard key={row.id} row={row} index={index} />
            ))}
          </div>
        ) : (
          <>
            <div
              className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm"
              data-testid="connector-workflows-empty"
            >
              <span className="flex-1 text-muted-foreground">
                {t("connectorDetail.usage.noWorkflows", { name: connectorName })}
              </span>
              {canCreate ? (
                <CreateAction
                  kind="workflow"
                  canChat={canChat}
                  size="sm"
                  variant="outline"
                  testId="connector-workflows-create"
                />
              ) : null}
            </div>
            {recipes.length > 0 && canChat ? (
              <section className="flex flex-col gap-2" data-testid="connector-recipes">
                <SectionHeading>
                  {t("connectorPage.usage.templates", { name: connectorName })}
                </SectionHeading>
                <TemplateGrid>
                  {recipes.map((recipe) => (
                    <TemplateCard
                      key={recipe.slug}
                      title={recipe.title}
                      line={recipe.description}
                      icons={[<ServiceIcon key="service" service={service} />]}
                      href={chatNewHref({
                        prompt: t("connectorPage.usage.recipePrompt", { title: recipe.title }),
                        connectorId,
                        references: [{ type: "connector", id: connectorId }],
                      })}
                      testId={`connector-recipe-${recipe.slug}`}
                    />
                  ))}
                </TemplateGrid>
              </section>
            ) : null}
          </>
        )}
      </div>
    </TabBody>
  );
}
