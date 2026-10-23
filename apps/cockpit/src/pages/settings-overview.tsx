import {
  Bell,
  Cable,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
  Server,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { absolute, settingsHref } from "@/app/links";
import {
  IconTile,
  READING_MEASURE,
  SectionHeading,
  StatusBadge,
} from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import type { AreaStatus, SettingAreaId } from "@/pages/settings-areas";
import { ExpertLink } from "@/pages/settings-guided";

export const AREA_ICON: Readonly<Record<SettingAreaId, LucideIcon>> = {
  ai: Sparkles,
  costs: Wallet,
  access: ShieldCheck,
  connections: Cable,
  notifications: Bell,
  operations: Server,
};

export const AREA_TITLE: Readonly<Record<SettingAreaId, TranslationKey>> = {
  ai: "settings.area.ai.title",
  costs: "settings.area.costs.title",
  access: "settings.area.access.title",
  connections: "settings.area.connections.title",
  notifications: "settings.area.notifications.title",
  operations: "settings.area.operations.title",
};

export const AREA_PURPOSE: Readonly<Record<SettingAreaId, TranslationKey>> = {
  ai: "settings.area.ai.purpose",
  costs: "settings.area.costs.purpose",
  access: "settings.area.access.purpose",
  connections: "settings.area.connections.purpose",
  notifications: "settings.area.notifications.purpose",
  operations: "settings.area.operations.purpose",
};

const STATUS_BADGE: Readonly<Record<AreaStatus, { state: string; label: TranslationKey }>> = {
  configured: { state: "ok", label: "settings.status.configured" },
  waiting: { state: "warn", label: "settings.status.waiting" },
  restart: { state: "warn", label: "settings.status.restart" },
  limit: { state: "error", label: "settings.status.limit" },
};

export interface AreaCard {
  id: SettingAreaId;
  sentence: string;
  status: AreaStatus | null;
  action?: ReactNode;
}

function navigateOnClick(onNavigate: (href: string) => void, href: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onNavigate(href);
  };
}

export function AreaStatusBadge({ status }: { status: AreaStatus | null }) {
  const { t } = useI18n();
  if (!status) return null;
  const badge = STATUS_BADGE[status];
  return (
    <StatusBadge
      state={badge.state}
      label={t(badge.label)}
      testId={`settings-area-status-${status}`}
    />
  );
}

export function SettingsOverview({
  cards,
  onNavigate,
}: {
  cards: readonly AreaCard[];
  onNavigate(href: string): void;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("grid gap-3", READING_MEASURE)} data-testid="settings-overview">
      <ul className="grid gap-3">
        {cards.map((card) => {
          const Icon = AREA_ICON[card.id];
          const href = settingsHref(null, { area: card.id });
          return (
            <li
              key={card.id}
              className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 rounded-xl border bg-background p-4 transition-colors hover:bg-muted/40"
              data-testid={`settings-area-card-${card.id}`}
            >
              <IconTile size="lg">
                <Icon />
              </IconTile>
              <div className="grid min-w-0 gap-0.5">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                  <a
                    href={absolute(href)}
                    className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
                    onClick={navigateOnClick(onNavigate, href)}
                    data-testid={`settings-area-link-${card.id}`}
                  >
                    {t(AREA_TITLE[card.id])}
                  </a>
                  {card.id === "operations" ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {t("settings.area.operations.audience")}
                    </span>
                  ) : null}
                </p>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid={`settings-area-sentence-${card.id}`}
                >
                  {card.sentence}
                </p>
                {card.action ? <div className="relative z-10 pt-2">{card.action}</div> : null}
              </div>
              <span className="flex items-center gap-2">
                <AreaStatusBadge status={card.status} />
                <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 grid gap-0.5 border-t pt-6">
        <ExpertLink
          href={settingsHref(null, { all: true })}
          label={t("settings.level.expert")}
          onNavigate={onNavigate}
          testId="settings-expert-link"
        />
        <p className="text-sm text-muted-foreground">{t("settings.level.expertLine")}</p>
      </div>
    </div>
  );
}

export function SettingsAreaFrame({
  area,
  drafted,
  attention,
  onNavigate,
  children,
}: {
  area: SettingAreaId;
  drafted: ReadonlySet<SettingAreaId>;
  attention: ReadonlySet<SettingAreaId>;
  onNavigate(href: string): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const areas = Object.keys(AREA_TITLE) as SettingAreaId[];
  const back = settingsHref();
  return (
    <div className="@container/settings" data-testid="settings-area-frame">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @min-[720px]/settings:grid-cols-[240px_minmax(0,1fr)]">
        <nav
          aria-label={t("settings.level.areas")}
          className="hidden self-start @min-[720px]/settings:sticky @min-[720px]/settings:top-0 @min-[720px]/settings:block"
          data-testid="settings-area-nav"
        >
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            {t("settings.level.areas")}
          </p>
          <ul className="grid gap-0.5">
            {areas.map((id) => {
              const Icon = AREA_ICON[id];
              const href = settingsHref(null, { area: id });
              const active = id === area;
              return (
                <li key={id}>
                  <a
                    href={absolute(href)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                      active && "bg-muted font-medium",
                    )}
                    onClick={navigateOnClick(onNavigate, href)}
                    data-testid={`settings-area-nav-${id}`}
                  >
                    <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1">{t(AREA_TITLE[id])}</span>
                    {drafted.has(id) || attention.has(id) ? (
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          drafted.has(id) ? "bg-foreground" : "bg-amber-500",
                        )}
                        data-testid={`settings-area-nav-mark-${id}`}
                      >
                        <span className="sr-only">
                          {drafted.has(id)
                            ? t("settings.sectionHasDrafts")
                            : t("settings.status.waiting")}
                        </span>
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 border-t px-2 pt-4">
            <ExpertLink
              href={settingsHref(null, { all: true })}
              label={t("settings.level.expert")}
              onNavigate={onNavigate}
              className="text-sm"
              testId="settings-area-nav-expert"
            />
          </div>
        </nav>
        <div className={cn("grid content-start gap-4", READING_MEASURE)}>
          <a
            href={absolute(back)}
            className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground hover:text-foreground"
            onClick={navigateOnClick(onNavigate, back)}
            data-testid="settings-all-areas"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            {t("settings.level.allAreas")}
          </a>
          <div className="grid gap-1">
            <SectionHeading className="flex flex-wrap items-baseline gap-x-2 text-xl font-semibold">
              {t(AREA_TITLE[area])}
              {area === "operations" ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {t("settings.area.operations.audience")}
                </span>
              ) : null}
            </SectionHeading>
            <p className="text-sm text-muted-foreground">{t(AREA_PURPOSE[area])}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
