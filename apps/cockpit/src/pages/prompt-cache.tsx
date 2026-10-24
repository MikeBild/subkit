import { ActionButton, KpiTile, Section } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type PromptCacheFlow, promptCacheShare, type Read } from "./operations-figures";

const FLOW_LABEL: Readonly<Record<string, { label: TranslationKey; hint: TranslationKey }>> = {
  converse: { label: "usage.cache.flow.converse", hint: "usage.cache.hint.converse" },
  suggest_next: { label: "usage.cache.flow.suggest_next", hint: "usage.cache.hint.suggest_next" },
  generate: { label: "usage.cache.flow.generate", hint: "usage.cache.hint.generate" },
  repair: { label: "usage.cache.flow.repair", hint: "usage.cache.hint.repair" },
  tool_repair: { label: "usage.cache.flow.tool_repair", hint: "usage.cache.hint.tool_repair" },
  critic_authoring: {
    label: "usage.cache.flow.critic_authoring",
    hint: "usage.cache.hint.critic_authoring",
  },
  summarize: { label: "usage.cache.flow.summarize", hint: "usage.cache.hint.summarize" },
  judge: { label: "usage.cache.flow.judge", hint: "usage.cache.hint.judge" },
  extract: { label: "usage.cache.flow.extract", hint: "usage.cache.hint.extract" },
  catalog_describe: {
    label: "usage.cache.flow.catalog_describe",
    hint: "usage.cache.hint.catalog_describe",
  },
  discover: { label: "usage.cache.flow.discover", hint: "usage.cache.hint.discover" },
  workflow_step: {
    label: "usage.cache.flow.workflow_step",
    hint: "usage.cache.hint.workflow_step",
  },
};

export type PromptCacheRead = Read<PromptCacheFlow[] | null>;

function useFlowText() {
  const { t } = useI18n();
  return (flow: string) => {
    const known = Object.hasOwn(FLOW_LABEL, flow) ? FLOW_LABEL[flow] : undefined;
    return known ? { label: t(known.label), hint: t(known.hint) } : { label: flow, hint: null };
  };
}

function flowsOf(read: PromptCacheRead): PromptCacheFlow[] | null {
  return read.state === "answered" ? read.value : null;
}

export function PromptCacheTile({
  read,
  period,
  onRetry,
}: {
  read: PromptCacheRead;
  period: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const label = `${t("usage.cache.tile")} · ${period}`;
  const flows = flowsOf(read);
  if (flows === null)
    return (
      <KpiTile
        label={label}
        testId="usage-kpi-prompt-cache"
        data={{ "data-figure-state": "unreadable" }}
        note={
          <>
            <span>{t("overview.operations.unreadable")}</span>
            <ActionButton
              variant="ghost"
              size="sm"
              onClick={onRetry}
              testId="usage-kpi-prompt-cache-retry"
            >
              {t("session.retry")}
            </ActionButton>
          </>
        }
      />
    );
  const share = promptCacheShare(flows);
  if (share === null)
    return (
      <KpiTile
        label={label}
        testId="usage-kpi-prompt-cache"
        data={{ "data-figure-state": "none" }}
        note={t("usage.cache.noData")}
      />
    );
  return (
    <KpiTile
      label={label}
      testId="usage-kpi-prompt-cache"
      data={{ "data-figure-state": "value" }}
      value={t("usage.cache.percent", { percent: share })}
      detail={t("usage.cache.tileDetail")}
      detailTestId="usage-kpi-prompt-cache-detail"
    />
  );
}

export function PromptCacheSection({
  read,
  onRetry,
}: {
  read: PromptCacheRead;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const flowText = useFlowText();
  const flows = flowsOf(read);
  const hasNoData = flows?.some((flow) => flow.percent === null) ?? false;
  return (
    <Section label={t("usage.cache.title")} testId="usage-prompt-cache">
      <p className="text-sm text-muted-foreground">{t("usage.cache.subtitle")}</p>
      {flows === null ? (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="usage-prompt-cache-unreadable"
        >
          <span>{t("overview.operations.unreadable")}</span>
          <ActionButton
            variant="ghost"
            size="sm"
            onClick={onRetry}
            testId="usage-prompt-cache-retry"
          >
            {t("session.retry")}
          </ActionButton>
        </p>
      ) : flows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="usage-prompt-cache-none">
          {t("overview.operations.none.cost")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {flows.map((flow) => {
            const text = flowText(flow.flow);
            const value =
              flow.percent === null
                ? t("usage.cache.noData")
                : t("usage.cache.percent", { percent: flow.percent });
            return (
              <li
                key={flow.flow}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem]"
                data-testid="usage-prompt-cache-flow"
                data-flow={flow.flow}
                data-cache-percent={flow.percent ?? undefined}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{text.label}</span>
                  {text.hint ? (
                    <span className="block text-xs text-muted-foreground">{text.hint}</span>
                  ) : null}
                </span>
                <span
                  role="img"
                  aria-label={
                    flow.percent === null
                      ? t("usage.cache.barNoData", { flow: text.label })
                      : t("usage.cache.barLabel", { flow: text.label, percent: flow.percent })
                  }
                  className="relative col-span-2 row-start-2 block h-1.5 w-full overflow-hidden rounded-full bg-muted sm:col-span-1 sm:row-start-auto"
                  data-testid="usage-prompt-cache-bar"
                >
                  {flow.percent === null ? null : (
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-chart-1"
                      style={{ width: `${flow.percent}%` }}
                    />
                  )}
                </span>
                <span
                  className={
                    flow.percent === null
                      ? "text-right text-xs text-muted-foreground"
                      : "text-right tabular-nums"
                  }
                  data-testid="usage-prompt-cache-value"
                >
                  {value}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {hasNoData ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-prompt-cache-footnote">
          {t("usage.cache.footnote")}
        </p>
      ) : null}
    </Section>
  );
}
