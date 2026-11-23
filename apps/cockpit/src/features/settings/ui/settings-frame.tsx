import { cn } from "@ui/lib/utils";
import {
  Bell,
  BookOpenCheck,
  Bot,
  Building2,
  Cable,
  Gauge,
  KeyRound,
  LifeBuoy,
  LockKeyhole,
  type LucideIcon,
  RefreshCw,
  Server,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { absolute, settingsHref, usageHref } from "@/app/links";
import { SectionHeading } from "@/components/cockpit/patterns";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/cockpit/patterns/controls";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { SettingAreaId } from "../model/settings-areas";
import { ExpertLink } from "./settings-guided";

const AREA_ICON: Readonly<Record<SettingAreaId, LucideIcon>> = {
  profile: Settings2,
  setup: Sparkles,
  people: Users,
  notifications: Bell,
  devices: ServerCog,
  updates: RefreshCw,
  privacy: LockKeyhole,
  rules: BookOpenCheck,
  vault: KeyRound,
  usage: Gauge,
  workspace: Building2,
  ai: Bot,
  access: ShieldCheck,
  connections: Cable,
  operations: Server,
  help: LifeBuoy,
};

const AREA_TITLE: Readonly<Record<SettingAreaId, TranslationKey>> = {
  profile: "settings.area.profile.title",
  setup: "settings.area.setup.title",
  people: "settings.area.people.title",
  notifications: "settings.area.notifications.title",
  devices: "settings.area.devices.title",
  updates: "settings.area.updates.title",
  privacy: "settings.area.privacy.title",
  rules: "settings.area.rules.title",
  vault: "settings.area.vault.title",
  usage: "settings.area.usage.title",
  workspace: "settings.area.workspace.title",
  ai: "settings.area.ai.title",
  access: "settings.area.access.title",
  connections: "settings.area.connections.title",
  operations: "settings.area.operations.title",
  help: "settings.area.help.title",
};

function navigateOnClick(onNavigate: (href: string) => void, href: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onNavigate(href);
  };
}

export function UsageNote() {
  const { t } = useI18n();
  return (
    <p className="text-sm text-muted-foreground" data-testid="settings-usage-note">
      {t("settings.usage.note")}{" "}
      <a
        href={absolute(usageHref())}
        className="font-medium text-foreground underline-offset-2 hover:underline"
        data-testid="settings-usage-link"
      >
        {t("overview.action.openUsage")} →
      </a>
    </p>
  );
}

function AreaMark({
  id,
  drafted,
  attention,
  testId,
}: {
  id: SettingAreaId;
  drafted: ReadonlySet<SettingAreaId>;
  attention: ReadonlySet<SettingAreaId>;
  testId: string | null;
}) {
  const { t } = useI18n();
  if (!drafted.has(id) && !attention.has(id)) return null;
  return (
    <span
      className={cn(
        "ml-auto size-1.5 shrink-0 rounded-full",
        drafted.has(id) ? "bg-foreground" : "bg-warning",
      )}
      data-testid={testId ?? undefined}
    >
      <span className="sr-only">
        {drafted.has(id) ? t("settings.sectionHasDrafts") : t("settings.status.waiting")}
      </span>
    </span>
  );
}

export function SettingsAreaFrame({
  area,
  areas,
  expert,
  drafted,
  attention,
  onNavigate,
  children,
}: {
  area: SettingAreaId;
  areas: readonly SettingAreaId[];
  expert: boolean;
  drafted: ReadonlySet<SettingAreaId>;
  attention: ReadonlySet<SettingAreaId>;
  onNavigate(href: string): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="@container/settings min-w-0" data-testid="settings-area-frame">
      <div className="flex flex-col gap-4 @min-[760px]/settings:flex-row">
        <div className="@min-[760px]/settings:hidden" data-testid="settings-area-select">
          <Select
            value={area}
            onValueChange={(next) => {
              const chosen = areas.find((id) => id === next);
              if (chosen) onNavigate(settingsHref(null, { area: chosen }));
            }}
          >
            <SelectTrigger
              aria-label={t("settings.level.areas")}
              className="w-full"
              data-testid="settings-area-select-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {areas.map((id) => {
                const Icon = AREA_ICON[id];
                return (
                  <SelectItem key={id} value={id} data-testid={`settings-area-select-${id}`}>
                    <span className="flex min-w-0 items-center gap-3">
                      <Icon aria-hidden="true" className="size-4 shrink-0" />
                      <span className="truncate">{t(AREA_TITLE[id])}</span>
                      <AreaMark id={id} drafted={drafted} attention={attention} testId={null} />
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <nav
          aria-label={t("settings.level.areas")}
          className="hidden shrink-0 flex-col gap-4 @min-[760px]/settings:flex @min-[760px]/settings:w-56"
          data-testid="settings-area-nav"
        >
          <ul className="flex flex-col gap-1">
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
                      "flex h-10 w-full items-center gap-3 whitespace-nowrap rounded-control px-3 text-left text-sm",
                      active
                        ? "bg-secondary font-medium"
                        : "text-muted-foreground hover:bg-secondary/60",
                    )}
                    onClick={navigateOnClick(onNavigate, href)}
                    data-testid={`settings-area-nav-${id}`}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">{t(AREA_TITLE[id])}</span>
                    <AreaMark
                      id={id}
                      drafted={drafted}
                      attention={attention}
                      testId={`settings-area-nav-mark-${id}`}
                    />
                  </a>
                </li>
              );
            })}
          </ul>
          {expert ? (
            <div className="border-t px-3 pt-4">
              <ExpertLink
                href={settingsHref(null, { all: true })}
                label={t("settings.level.expert")}
                onNavigate={onNavigate}
                className="text-sm"
                testId="settings-area-nav-expert"
              />
            </div>
          ) : null}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <SectionHeading className="sr-only">{t(AREA_TITLE[area])}</SectionHeading>
          {area === "operations" ? (
            <p className="text-xs text-muted-foreground" data-testid="settings-area-audience">
              {t("settings.area.operations.audience")}
            </p>
          ) : null}
          {children}
          {expert ? (
            <div className="border-t pt-4 @min-[760px]/settings:hidden">
              <ExpertLink
                href={settingsHref(null, { all: true })}
                label={t("settings.level.expert")}
                onNavigate={onNavigate}
                className="text-sm"
                testId="settings-area-expert"
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
