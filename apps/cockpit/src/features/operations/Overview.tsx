import { IconTile } from "@ui/atoms/icon-tile";
import type { Tone } from "@ui/atoms/pill";
import { Panel, Pill } from "@ui/atoms/pill";
import { StatusDot } from "@ui/atoms/status-dot";
import { cn } from "@ui/lib/utils";
import { Sparkline } from "@ui/molecules/charts";
import { EmptyState } from "@ui/molecules/empty-state";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Coins,
  Inbox,
  KeyRound,
  type LucideIcon,
  MessageCircleQuestion,
  OctagonX,
  PauseCircle,
  PlugZap,
  ShieldAlert,
  ShieldCheck,
  Workflow as WorkflowIcon,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { connectorDots, type NeedIcon, needVisual } from "@/features/operations/model/operations";
import { useI18n } from "@/lib/i18n-context";

export interface KpiCard {
  id: string;
  label: string;
  value: string;
  note: string | null;
  href: string | null;
  trend: number[] | null;
  dots: { enabled: number; notOk: number; needsReauth: number } | null;
  detail: string | null;
  tone: Extract<Tone, "warning" | "danger"> | null;
  link: { label: string; href: string } | null;
  retry: boolean;
}

const VALUE_INK = { warning: "text-warning-ink", danger: "text-destructive-ink" } as const;

const KPI_ICON: Record<string, LucideIcon> = {
  runs: Activity,
  successRate: CheckCircle2,
  connectorHealth: PlugZap,
  repairRate: Wrench,
  cost: Coins,
  budget: Coins,
};

export function OverviewKpis({
  cards,
  onRetry,
}: {
  cards: KpiCard[];
  onRetry?: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="@container" data-testid="operations-bar">
      <div className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
        {cards.map((k) => (
          <Panel key={k.id} className="flex flex-col gap-3">
            <div className="flex items-center gap-3" data-testid={`operations-figure-${k.id}`}>
              <IconTile icon={KPI_ICON[k.id] ?? Activity} size="sm" />
              <span className="min-w-0 text-xs text-muted-foreground">{k.label}</span>
            </div>
            <div
              className={cn("font-heading text-xl font-semibold", k.tone && VALUE_INK[k.tone])}
              data-testid={`operations-figure-${k.id}-value`}
              data-budget-pressure={k.tone ?? undefined}
            >
              {k.href ? (
                <a
                  href={k.href}
                  className="underline-offset-4 hover:underline"
                  data-testid={`operations-figure-${k.id}-link`}
                >
                  {k.value}
                </a>
              ) : (
                k.value
              )}
            </div>
            {k.detail || k.link ? (
              <p
                className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
                data-testid={`operations-figure-${k.id}-detail`}
              >
                {k.detail ? <span>{k.detail}</span> : null}
                {k.detail && k.link ? <span aria-hidden>·</span> : null}
                {k.link ? (
                  <a
                    href={k.link.href}
                    className="font-medium text-foreground underline underline-offset-2"
                    data-testid={`operations-figure-${k.id}-set-budget`}
                  >
                    {k.link.label}
                  </a>
                ) : null}
              </p>
            ) : null}
            {k.note ? (
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                {k.note}
                {k.retry && onRetry ? (
                  <button
                    type="button"
                    onClick={() => onRetry(k.id)}
                    className="font-medium text-foreground underline underline-offset-2"
                    data-testid={`operations-figure-${k.id}-retry`}
                  >
                    {t("session.retry")}
                  </button>
                ) : null}
              </p>
            ) : k.trend ? (
              <Sparkline data={k.trend} label={t("ops.kpi.trend", { label: k.label })} />
            ) : k.dots ? (
              <div
                className="flex min-h-8 flex-wrap items-center gap-1"
                role="img"
                aria-label={t("ops.kpi.connectors", {
                  healthy: k.dots.enabled - k.dots.notOk,
                  total: k.dots.enabled,
                })}
                data-testid="kpi-connector-dots"
              >
                {connectorDots(k.dots).map((tone, index) => (
                  <StatusDot key={`${tone}-${index}`} tone={tone} />
                ))}
              </div>
            ) : (
              <div className="h-8" aria-hidden />
            )}
          </Panel>
        ))}
      </div>
    </div>
  );
}

const NEED_ICONS: Record<NeedIcon, LucideIcon> = {
  answer: MessageCircleQuestion,
  approval: ShieldCheck,
  expiry: CalendarClock,
  paused: PauseCircle,
  failed: OctagonX,
  connector: PlugZap,
  proposal: Inbox,
  task: ClipboardCheck,
  budget: Coins,
  key: KeyRound,
  risk: ShieldAlert,
};

export function NeedRow({
  reason,
  state,
  title,
  hint,
  action,
  testId,
}: {
  reason: string;
  state: string;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  const { tone, icon } = needVisual(reason);
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border p-5"
      data-testid={testId}
      data-need-tone={tone}
    >
      <IconTile icon={NEED_ICONS[icon]} tone={tone} size="lg" />
      <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <Pill tone={tone}>{state}</Pill>
          {title}
        </div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

export function NeedsAllClear() {
  const { t } = useI18n();
  return (
    <div data-testid="needs-all-clear">
      <EmptyState icon={CheckCircle2} title={t("ops.needs.allClear")} />
    </div>
  );
}

export function RunRow({
  tone,
  pulse,
  name,
  outcome,
  time,
  href,
  onOpen,
  testId,
}: {
  tone: Tone;
  pulse?: boolean;
  name: ReactNode;
  outcome: string;
  time: string;
  href: string;
  onOpen?: () => void;
  testId?: string;
}) {
  return (
    <li>
      <a
        href={href}
        onClick={(event) => {
          if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
            return;
          event.preventDefault();
          onOpen();
        }}
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-secondary"
        data-testid={testId}
      >
        <IconTile icon={WorkflowIcon} size="sm" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="flex items-center gap-2 text-xs">
          <StatusDot tone={tone} pulse={pulse ?? false} />
          {outcome}
        </span>
        <span className="whitespace-nowrap text-xs text-muted-foreground">{time}</span>
      </a>
    </li>
  );
}
