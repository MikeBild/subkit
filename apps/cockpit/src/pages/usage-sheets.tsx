import { useQuery } from "@tanstack/react-query";
import { CircleAlert, MessageSquare, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { apiRequest } from "@/api/client";
import { absolute, conversationHref, runHref, settingsHref, workflowHref } from "@/app/links";
import {
  ActionButton,
  CollapsibleSection,
  CopyField,
  DataState,
  FactList,
  IconTile,
  KpiTile,
  RecordSheet,
  Section,
} from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  type LlmStatsFilter,
  llmStatsEndpoint,
  type StatsWindow,
  type TimeSpan,
  type WindowBounds,
} from "@/pages/operations-figures";
import {
  ORIGIN_COLOR,
  ORIGIN_HELP,
  ORIGIN_LABEL,
  PREVIOUS_LABEL,
  ShareBar,
  type UsageFormat,
  WINDOW_OPTION,
} from "@/pages/usage-format";
import {
  type ConsumptionAxis,
  FAILED_RESULTS,
  failureRows,
  type LlmGroupView,
  type LlmWindow,
  llmGroups,
  llmWindow,
  type OriginRow,
  originRows,
  RUN_COST_FACTOR,
  runCostFactor,
  type UsageOrigin,
  type UsageSheet,
  type WorkflowRunCost,
} from "@/pages/usage-model";

const REASON_LABEL: Record<string, TranslationKey> = {
  error: "usage.reason.error",
  context_too_large: "usage.reason.contextTooLarge",
  quota_exhausted: "usage.reason.quotaExhausted",
};

export interface SheetContext {
  bounds: WindowBounds;
  window: LlmWindow | null;
  format: UsageFormat;
  canAll: boolean;
  canWriteSettings: boolean;
  priceSettingReadable: boolean;
  origins: readonly OriginRow[];
  workflowCost(id: string): WorkflowRunCost | null;
  modelGroup(id: string): LlmGroupView | null;
  conversationGroup(id: string): LlmGroupView | null;
  modelsPending: boolean;
  conversationsPending: boolean;
  workflowName(id: string): string;
  personName(id: string | null): string;
  modelName(id: string): string;
  open(sheet: UsageSheet): void;
  close(): void;
  setPrice(model: string): void;
}

function useLlm(
  enabled: boolean,
  span: TimeSpan & { window: StatsWindow },
  axis: ConsumptionAxis | readonly ConsumptionAxis[],
  filter: LlmStatsFilter = {},
) {
  return useQuery({
    queryKey: ["usage-llm", "sheet", span, axis, filter],
    enabled,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(span, axis, filter)),
  });
}

interface ListItem {
  key: string;
  icon?: ReactNode;
  label: string;
  sub?: string;
  value: string;
  onOpen?(): void;
  href?: string;
}

function SheetList({ items, empty }: { items: readonly ListItem[]; empty: string }) {
  const { t } = useI18n();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {items.map((item) => {
        const body = (
          <>
            {item.icon}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{item.label}</span>
              {item.sub ? (
                <span className="block text-xs text-muted-foreground">{item.sub}</span>
              ) : null}
            </span>
            <span className="tabular-nums">{item.value}</span>
          </>
        );
        const row = "flex w-full items-center gap-3 px-3 py-2 text-left";
        return (
          <li key={item.key}>
            {item.onOpen ? (
              <button
                type="button"
                onClick={item.onOpen}
                aria-label={t("usage.openDetails", { name: item.label })}
                className={`${row} transition-colors hover:bg-muted/50`}
              >
                {body}
              </button>
            ) : item.href ? (
              <a className={`${row} transition-colors hover:bg-muted/50`} href={item.href}>
                {body}
              </a>
            ) : (
              <div className={row}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Tiles({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "grid grid-cols-2 gap-2 sm:grid-cols-4" : "grid grid-cols-2 gap-2"}>
      {children}
    </div>
  );
}

function Failed({ onRetry }: { onRetry(): void }) {
  const { t } = useI18n();
  return (
    <DataState
      state="error"
      line={t("usage.sheet.unreadable")}
      onRetry={onRetry}
      testId="usage-sheet-error"
    />
  );
}

function OriginSheet({ ctx, origin }: { ctx: SheetContext; origin: UsageOrigin }) {
  const { t } = useI18n();
  const row = ctx.origins.find((candidate) => candidate.key === origin);
  const axis: ConsumptionAxis =
    origin === "workflowRuns" ? "workflow" : ctx.canAll ? "user" : "model";
  const flows = row?.flows ?? [];
  const items = useLlm(flows.length > 0, ctx.bounds, axis, { flows });
  const groups = llmGroups(items.data);
  const list: ListItem[] = groups
    .filter((group) => group.calls > 0)
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls)
    .map((group) => {
      const id = group.key[axis] ?? "";
      const value = group.cost === null ? t("usage.unpriced") : ctx.format.money(group.cost);
      if (axis === "workflow")
        return id
          ? {
              key: id,
              label: ctx.workflowName(id),
              sub: t("usage.axis.workflow"),
              value,
              onOpen: () => ctx.open({ kind: "workflow", id }),
            }
          : { key: "", label: t("usage.remainder.workflow"), value };
      if (axis === "user")
        return {
          key: id,
          label: ctx.personName(id || null),
          value,
          ...(id ? { onOpen: () => ctx.open({ kind: "person", id }) } : {}),
        };
      return {
        key: id,
        label: ctx.modelName(id),
        value,
        onOpen: () => ctx.open({ kind: "model", id }),
      };
    });
  return (
    <RecordSheet
      open
      onOpenChange={(open) => (open ? undefined : ctx.close())}
      testId="usage-origin-sheet"
      title={t(ORIGIN_LABEL[origin])}
      subtitle={`${t(WINDOW_OPTION[ctx.bounds.window])} · ${t("usage.sheet.shareOfCost", {
        percent: ctx.format.percent(row?.share ?? null),
      })}`}
      loading={items.isPending && flows.length > 0}
    >
      <div className="flex flex-col gap-6">
        <p className="text-sm">{t(ORIGIN_HELP[origin])}</p>
        <Tiles>
          <KpiTile
            label={t("resource.usage.cost")}
            value={row?.cost === null || !row ? t("usage.unpriced") : ctx.format.money(row.cost)}
          />
          <KpiTile label={t("usage.calls")} value={ctx.format.count(row?.calls ?? 0)} />
        </Tiles>
        <Section label={t("usage.sheet.largest")}>
          {items.isError ? (
            <Failed onRetry={() => void items.refetch()} />
          ) : (
            <SheetList items={list} empty={t("usage.sheet.nothing")} />
          )}
        </Section>
        <CollapsibleSection label={t("usage.tech.title")}>
          <FactList
            items={[
              {
                label: t("usage.tech.flows"),
                value: <span className="font-mono text-xs">{flows.join(", ") || "–"}</span>,
              },
            ]}
          />
        </CollapsibleSection>
      </div>
    </RecordSheet>
  );
}

function WorkflowSheet({ ctx, id }: { ctx: SheetContext; id: string }) {
  const { t } = useI18n();
  const runs = useLlm(true, ctx.bounds, "execution", { workflowId: id });
  const models = useLlm(true, ctx.bounds, "model", { workflowId: id });
  const cost = ctx.workflowCost(id);
  const runCount = cost?.runs ?? 0;
  const perRun = cost && cost.cost !== null && runCount > 0 ? cost.cost / runCount : null;
  const runWindow = llmWindow(runs.data);
  const callsPerRun = runWindow && runCount > 0 ? runWindow.calls / runCount : null;
  const previousPerRun =
    cost && cost.previousCost !== null && cost.previousRuns > 0
      ? cost.previousCost / cost.previousRuns
      : null;
  const factor = cost ? runCostFactor(cost) : null;
  const previous = t(PREVIOUS_LABEL[ctx.bounds.window]);
  const expensive: ListItem[] = llmGroups(runs.data)
    .filter((group) => (group.key.execution ?? "") !== "")
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
    .slice(0, 3)
    .map((group) => {
      const executionId = group.key.execution ?? "";
      const first = group.buckets.find((bucket) => bucket.calls > 0);
      return {
        key: executionId,
        label: t("usage.sheet.runOn", { date: ctx.format.dateLabel(first?.ts ?? "") }),
        sub: t("usage.sheet.callsCount", { count: ctx.format.count(group.calls) }),
        value: group.cost === null ? t("usage.unpriced") : ctx.format.money(group.cost),
        href: absolute(runHref(executionId)),
      };
    });
  const used: ListItem[] = llmGroups(models.data).map((group) => {
    const model = group.key.model ?? "";
    return {
      key: model,
      label: group.modelName ?? model,
      value: group.cost === null ? t("usage.unpriced") : ctx.format.money(group.cost),
      onOpen: () => ctx.open({ kind: "model", id: model }),
    };
  });
  return (
    <RecordSheet
      open
      onOpenChange={(open) => (open ? undefined : ctx.close())}
      testId="usage-workflow-sheet"
      title={ctx.workflowName(id)}
      subtitle={`${t("usage.axis.workflow")} · ${t(WINDOW_OPTION[ctx.bounds.window])}`}
      action={
        <ActionButton
          onClick={() => window.location.assign(absolute(workflowHref(id)))}
          testId="usage-workflow-open"
        >
          {t("usage.sheet.openWorkflow")}
        </ActionButton>
      }
    >
      <div className="flex flex-col gap-6">
        <Tiles wide>
          <KpiTile
            label={t("resource.usage.cost")}
            value={cost?.cost == null ? "–" : ctx.format.money(cost.cost)}
          />
          <KpiTile label={t("resource.usage.runs")} value={ctx.format.count(runCount)} />
          <KpiTile
            label={t("usage.sheet.costPerRun")}
            value={perRun === null ? "–" : ctx.format.money(perRun)}
          />
          <KpiTile
            label={t("usage.sheet.callsPerRun")}
            value={callsPerRun === null ? "–" : ctx.format.count(callsPerRun)}
          />
        </Tiles>
        {previousPerRun !== null ? (
          <p className="text-sm" data-testid="usage-workflow-per-run">
            {factor !== null && factor >= RUN_COST_FACTOR
              ? t("usage.sheet.perRunFactor", {
                  factor: factor.toLocaleString(),
                  previous,
                  amount: ctx.format.money(previousPerRun),
                })
              : t("usage.sheet.perRunBefore", {
                  previous,
                  amount: ctx.format.money(previousPerRun),
                })}
          </p>
        ) : null}
        <Section label={t("usage.sheet.expensiveRuns")}>
          {runs.isError ? (
            <Failed onRetry={() => void runs.refetch()} />
          ) : (
            <SheetList items={expensive} empty={t("usage.sheet.nothing")} />
          )}
        </Section>
        <Section label={t("usage.sheet.modelsUsed")}>
          {models.isError ? (
            <Failed onRetry={() => void models.refetch()} />
          ) : (
            <SheetList items={used} empty={t("usage.sheet.nothing")} />
          )}
        </Section>
        <CollapsibleSection label={t("usage.tech.title")}>
          <CopyField value={id} label={t("usage.tech.workflowId")} labelled />
        </CollapsibleSection>
      </div>
    </RecordSheet>
  );
}

function PersonSheet({ ctx, id }: { ctx: SheetContext; id: string }) {
  const { t } = useI18n();
  const filter = { userId: id };
  const flows = useLlm(true, ctx.bounds, "flow", filter);
  const workflows = useLlm(true, ctx.bounds, "workflow", filter);
  const conversations = useLlm(ctx.canAll, ctx.bounds, "conversation", filter);
  const own = llmWindow(flows.data);
  const origins = originRows(flows.data);
  const total = own?.cost?.amount ?? null;
  const workflowItems: ListItem[] = llmGroups(workflows.data)
    .filter((group) => (group.key.workflow ?? "") !== "")
    .map((group) => {
      const workflowId = group.key.workflow ?? "";
      return {
        key: workflowId,
        label: ctx.workflowName(workflowId),
        value: group.cost === null ? t("usage.unpriced") : ctx.format.money(group.cost),
        onOpen: () => ctx.open({ kind: "workflow", id: workflowId }),
      };
    });
  const conversationItems: ListItem[] = llmGroups(conversations.data)
    .filter((group) => (group.key.conversation ?? "") !== "")
    .map((group) => {
      const conversationId = group.key.conversation ?? "";
      return {
        key: conversationId,
        label:
          group.conversation?.title ??
          t("usage.untitledConversation", {
            date: ctx.format.dateLabel(group.conversation?.updatedAt ?? ""),
          }),
        value: group.cost === null ? t("usage.unpriced") : ctx.format.money(group.cost),
        onOpen: () => ctx.open({ kind: "conversation", id: conversationId }),
      };
    });
  return (
    <RecordSheet
      open
      onOpenChange={(open) => (open ? undefined : ctx.close())}
      testId="usage-person-sheet"
      title={ctx.personName(id)}
      subtitle={t(WINDOW_OPTION[ctx.bounds.window])}
      loading={flows.isPending}
    >
      {flows.isError ? (
        <Failed onRetry={() => void flows.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <Tiles>
            <KpiTile
              label={t("resource.usage.cost")}
              value={own?.cost ? ctx.format.money(own.cost.amount) : "–"}
              prefix={
                own?.cost && own.cost.unpricedCalls > 0 ? t("overview.operations.atLeast") : null
              }
            />
            <KpiTile label={t("usage.calls")} value={ctx.format.count(own?.calls ?? 0)} />
          </Tiles>
          <Section label={t("usage.sheet.whereFrom")}>
            <ul className="flex flex-col gap-2">
              {origins.map((origin) => (
                <li
                  key={origin.key}
                  className="grid grid-cols-[minmax(0,150px)_1fr_auto] items-center gap-3 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ background: ORIGIN_COLOR[origin.key] }}
                    />
                    <span className="truncate">{t(ORIGIN_LABEL[origin.key])}</span>
                  </span>
                  <ShareBar
                    share={total && origin.cost !== null ? origin.cost / total : origin.share}
                    color={ORIGIN_COLOR[origin.key]}
                  />
                  <span className="w-20 text-right tabular-nums">
                    {origin.cost === null ? t("usage.unpriced") : ctx.format.money(origin.cost)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          {workflowItems.length > 0 ? (
            <Section label={t("usage.sheet.workflows")}>
              <SheetList items={workflowItems} empty={t("usage.sheet.nothing")} />
            </Section>
          ) : null}
          {conversationItems.length > 0 ? (
            <Section label={t("usage.sheet.conversations")}>
              <SheetList items={conversationItems} empty={t("usage.sheet.nothing")} />
            </Section>
          ) : null}
        </div>
      )}
    </RecordSheet>
  );
}

function ModelSheet({ ctx, id }: { ctx: SheetContext; id: string }) {
  const { t, locale } = useI18n();
  const group = ctx.modelGroup(id);
  const name = group?.modelName ?? id;
  const price = group?.modelPrice ?? null;
  const failed = group
    ? Object.entries(group.results)
        .filter(([result]) => result !== "success")
        .reduce((sum, [, n]) => sum + n, 0)
    : 0;
  const unpriced = group !== null && price === null;
  const perSecond = new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
    maximumFractionDigits: 1,
  });
  return (
    <RecordSheet
      open
      onOpenChange={(open) => (open ? undefined : ctx.close())}
      testId="usage-model-sheet"
      title={name}
      subtitle={t(WINDOW_OPTION[ctx.bounds.window])}
      loading={ctx.modelsPending}
    >
      <div className="flex flex-col gap-6">
        {unpriced ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm"
            data-testid="usage-model-unpriced"
          >
            <CircleAlert aria-hidden="true" className="size-4 text-warning" />
            <span className="min-w-0 flex-1">
              {t("usage.sheet.modelUnpriced", { count: ctx.format.count(group?.calls ?? 0) })}
            </span>
            {ctx.canWriteSettings && ctx.priceSettingReadable ? (
              <ActionButton size="sm" onClick={() => ctx.setPrice(id)} testId="usage-price-open">
                {t("usage.price.action")}
              </ActionButton>
            ) : ctx.canWriteSettings ? (
              <a
                className="font-medium underline underline-offset-2"
                href={absolute(settingsHref("tokens.prices"))}
              >
                {t("usage.price.action")}
              </a>
            ) : (
              <span className="text-muted-foreground">{t("usage.askAdmin")}</span>
            )}
          </div>
        ) : null}
        <Tiles wide>
          <KpiTile
            label={t("resource.usage.cost")}
            value={group?.cost == null ? "–" : ctx.format.money(group.cost)}
          />
          <KpiTile label={t("usage.calls")} value={ctx.format.count(group?.calls ?? 0)} />
          <KpiTile
            label={t("usage.sheet.cacheShare")}
            value={ctx.format.percent(
              group && group.tokens.prompt > 0
                ? group.tokens.cacheRead / group.tokens.prompt
                : null,
            )}
          />
          <KpiTile
            label={t("usage.sheet.errorRate")}
            value={ctx.format.percent(group && group.calls > 0 ? failed / group.calls : null)}
          />
        </Tiles>
        <Section label={t("usage.sheet.pricePerMillion")}>
          <FactList
            items={[
              {
                label: t("usage.price.inputShort"),
                value: price ? ctx.format.money(price.inputPerMtok) : "–",
              },
              {
                label: t("usage.price.outputShort"),
                value: price ? ctx.format.money(price.outputPerMtok) : "–",
              },
              {
                label: t("usage.price.cacheShort"),
                value: price ? ctx.format.money(price.cacheReadPerMtok) : "–",
              },
              {
                label: t("usage.sheet.latency"),
                help: t("usage.sheet.latencyHelp"),
                value:
                  group?.latencyP50 == null
                    ? "–"
                    : t("usage.sheet.seconds", {
                        seconds: perSecond.format(group.latencyP50 / 1000),
                      }),
              },
            ]}
          />
        </Section>
        <CollapsibleSection label={t("usage.tech.title")}>
          <div className="flex flex-col gap-3">
            <FactList
              items={[
                {
                  label: t("usage.tech.priceSource"),
                  value: price ? t("usage.tech.priceKnown") : t("usage.tech.priceNone"),
                },
              ]}
            />
            <CopyField value={id} label={t("usage.tech.modelId")} labelled />
          </div>
        </CollapsibleSection>
      </div>
    </RecordSheet>
  );
}

function ConversationSheet({ ctx, id }: { ctx: SheetContext; id: string }) {
  const { t } = useI18n();
  const group = ctx.conversationGroup(id);
  const title =
    group?.conversation?.title ??
    t("usage.untitledConversation", {
      date: ctx.format.dateLabel(group?.conversation?.updatedAt ?? ""),
    });
  return (
    <RecordSheet
      open
      onOpenChange={(open) => (open ? undefined : ctx.close())}
      testId="usage-conversation-sheet"
      title={title}
      subtitle={
        group?.conversation
          ? t("usage.sheet.conversationSubtitle", {
              name: ctx.personName(group.conversation.ownerId),
              date: ctx.format.dateLabel(group.conversation.updatedAt),
            })
          : t(WINDOW_OPTION[ctx.bounds.window])
      }
      loading={ctx.conversationsPending}
      action={
        <ActionButton
          onClick={() => window.location.assign(absolute(conversationHref(id)))}
          testId="usage-conversation-open"
        >
          {t("usage.sheet.openConversation")}
        </ActionButton>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-3 gap-2">
          <KpiTile
            label={t("resource.usage.cost")}
            value={group?.cost == null ? "–" : ctx.format.money(group.cost)}
          />
          <KpiTile label={t("usage.calls")} value={ctx.format.count(group?.calls ?? 0)} />
          <KpiTile
            label={t("usage.sheet.fromCache")}
            value={ctx.format.percent(
              group && group.tokens.prompt > 0
                ? group.tokens.cacheRead / group.tokens.prompt
                : null,
            )}
          />
        </div>
        <p className="text-sm text-muted-foreground">{t("usage.sheet.longConversations")}</p>
      </div>
    </RecordSheet>
  );
}

function FailedSheet({ ctx }: { ctx: SheetContext }) {
  const { t } = useI18n();
  const axes: ConsumptionAxis[] = ctx.canAll ? ["workflow", "conversation"] : ["workflow"];
  const failed = useLlm(true, ctx.bounds, axes, { results: FAILED_RESULTS });
  const rows = failureRows(failed.data);
  const failedWindow = llmWindow(failed.data);
  const amount = failedWindow?.cost?.amount ?? 0;
  const period = t(WINDOW_OPTION[ctx.bounds.window]);
  const items: ListItem[] = rows.map((row, index) => {
    const reasons = row.reasons
      .map((reason) => t(REASON_LABEL[reason.result] ?? "usage.reason.error"))
      .join(", ");
    const sub = `${ctx.format.count(row.calls)}× · ${reasons}`;
    const value = row.cost === null ? t("usage.unpriced") : ctx.format.money(row.cost);
    if (row.workflowId) {
      const workflowId = row.workflowId;
      return {
        key: `w-${workflowId}`,
        icon: (
          <IconTile size="sm">
            <Workflow />
          </IconTile>
        ),
        label: ctx.workflowName(workflowId),
        sub,
        value,
        onOpen: () => ctx.open({ kind: "workflow", id: workflowId }),
      };
    }
    if (row.conversationId) {
      const conversationId = row.conversationId;
      return {
        key: `c-${conversationId}`,
        icon: (
          <IconTile size="sm">
            <MessageSquare />
          </IconTile>
        ),
        label: row.title ?? t("usage.untitledConversationShort"),
        sub,
        value,
        onOpen: () => ctx.open({ kind: "conversation", id: conversationId }),
      };
    }
    return { key: `o-${index}`, label: t("resource.usage.origin.other"), sub, value };
  });
  return (
    <RecordSheet
      open
      onOpenChange={(open) => (open ? undefined : ctx.close())}
      testId="usage-failed-sheet"
      title={t("usage.failed.title")}
      subtitle={t("usage.failed.subtitle", {
        period,
        failed: ctx.format.count(ctx.window?.failedCalls ?? 0),
        calls: ctx.format.count(ctx.window?.calls ?? 0),
      })}
      loading={failed.isPending}
    >
      {failed.isError ? (
        <Failed onRetry={() => void failed.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <p className="text-sm" data-testid="usage-failed-cost">
            {amount > 0
              ? t("usage.failed.cost", { period, amount: ctx.format.money(amount) })
              : t("usage.failed.free")}
          </p>
          <Section label={t("usage.failed.where")}>
            <SheetList items={items} empty={t("usage.sheet.nothing")} />
          </Section>
        </div>
      )}
    </RecordSheet>
  );
}

export function UsageSheetView({ ctx, sheet }: { ctx: SheetContext; sheet: UsageSheet | null }) {
  if (!sheet) return null;
  if (sheet.kind === "origin") return <OriginSheet key={sheet.id} ctx={ctx} origin={sheet.id} />;
  if (sheet.kind === "workflow") return <WorkflowSheet key={sheet.id} ctx={ctx} id={sheet.id} />;
  if (sheet.kind === "person")
    return ctx.canAll ? <PersonSheet key={sheet.id} ctx={ctx} id={sheet.id} /> : null;
  if (sheet.kind === "model") return <ModelSheet key={sheet.id} ctx={ctx} id={sheet.id} />;
  if (sheet.kind === "conversation")
    return ctx.canAll ? <ConversationSheet key={sheet.id} ctx={ctx} id={sheet.id} /> : null;
  return <FailedSheet ctx={ctx} />;
}
