import { ChevronRight, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { ContextHelp, SectionHeading, SegmentedControl } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import type { SettingAreaId } from "@/pages/settings-areas";
import type { ModelCatalog } from "@/pages/settings-catalog";
import {
  type SettingDraft,
  type SettingDraftScope,
  type SettingItem,
  settingFieldValue,
  settingValueText,
} from "@/pages/settings-model";
import { SettingField } from "@/pages/settings-rows";
import type { BudgetSummary } from "@/pages/usage-model";

export interface GuidedContext {
  items: readonly SettingItem[];
  globalItems: readonly SettingItem[];
  tenantItems: readonly SettingItem[] | null;
  drafts: Readonly<Record<string, SettingDraft>>;
  canWrite: boolean;
  pending: boolean;
  scope: SettingDraftScope;
  scopeAvailable: boolean;
  catalog: ModelCatalog | undefined;
  usage: BudgetSummary | null;
  publicBaseUrl: string;
  setDraft(path: string, text: string): void;
  dropDraft(path: string): void;
  onScope(scope: SettingDraftScope): void;
  expertHref(area: SettingAreaId): string;
  navigate(href: string): void;
}

export function guidedItem(ctx: GuidedContext, path: string): SettingItem | undefined {
  return ctx.items.find((item) => item.path === path);
}

export function guidedText(ctx: GuidedContext, path: string): string {
  const draft = ctx.drafts[path];
  if (draft) return draft.text;
  const item = guidedItem(ctx, path);
  return item ? settingFieldValue(item, undefined) : "";
}

export function guidedLocked(item: SettingItem | undefined): boolean {
  return item?.meta.source === "override";
}

export function guidedDisabled(ctx: GuidedContext, item: SettingItem | undefined): boolean {
  return !ctx.canWrite || ctx.pending || !item || guidedLocked(item);
}

export function guidedIndex(ctx: GuidedContext, path: string): number {
  return ctx.items.findIndex((item) => item.path === path);
}

export function Question({
  title,
  help,
  aside,
  testId,
  children,
}: {
  title: string;
  help?: ReactNode;
  aside?: ReactNode;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className="grid gap-3 rounded-xl border bg-background p-4 sm:p-5"
      data-slot="settings-question"
      data-testid={testId}
    >
      <div className="grid gap-1">
        <div className="flex items-start justify-between gap-3">
          <SectionHeading className="text-base font-semibold">{title}</SectionHeading>
          {aside}
        </div>
        {help ? <p className="text-sm text-muted-foreground">{help}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function LockedNote({ item }: { item: SettingItem | undefined }) {
  const { t } = useI18n();
  if (!guidedLocked(item)) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Lock aria-hidden="true" className="size-3" />
      <ContextHelp
        label={t("settings.meta.environment")}
        testId={`settings-locked-${item?.path ?? "setting"}`}
      >
        {t("settings.locked.environment")}
      </ContextHelp>
      {t("settings.meta.environment")}
    </span>
  );
}

export function OwnValueHint({ ctx, path }: { ctx: GuidedContext; path: string }) {
  const { t } = useI18n();
  if (ctx.scope !== "tenant" || !ctx.tenantItems) return null;
  const own = ctx.tenantItems.find((item) => item.path === path);
  if (own?.meta.source !== "tenant") return null;
  const general = ctx.globalItems.find((item) => item.path === path);
  return (
    <p className="text-xs text-muted-foreground" data-testid={`settings-own-value-${path}`}>
      {t("settings.scope.ownValue", { globalValue: settingValueText(general?.value, t) })}
    </p>
  );
}

export function ScopeToggle({
  ctx,
  tenantLabel,
  globalLabel,
  globalHelp,
}: {
  ctx: GuidedContext;
  tenantLabel?: string;
  globalLabel?: string;
  globalHelp?: string;
}) {
  const { t } = useI18n();
  if (!ctx.scopeAvailable) return null;
  return (
    <div className="grid gap-1.5" data-testid="settings-scope">
      <p className="text-xs font-medium text-muted-foreground">{t("settings.scope.question")}</p>
      <SegmentedControl
        value={ctx.scope}
        onValueChange={(next) => {
          if (next === "tenant" || next === "global") ctx.onScope(next);
        }}
        label={t("settings.scope.question")}
        testId="settings-scope-toggle"
        options={[
          {
            value: "tenant",
            label: tenantLabel ?? t("settings.scope.tenant"),
            testId: "settings-scope-tenant",
          },
          {
            value: "global",
            label: globalLabel ?? t("settings.scope.global"),
            testId: "settings-scope-global",
          },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        {ctx.scope === "tenant"
          ? t("settings.scope.tenantHelp")
          : (globalHelp ?? t("settings.scope.globalHelp"))}
      </p>
    </div>
  );
}

export function GuidedRows({ ctx, paths }: { ctx: GuidedContext; paths: readonly string[] }) {
  const rows = paths.flatMap((path) => {
    const item = guidedItem(ctx, path);
    return item ? [item] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div className="@container/settings-panel overflow-hidden rounded-lg border">
      {rows.map((item) => (
        <SettingField
          key={item.path}
          item={item}
          index={guidedIndex(ctx, item.path)}
          items={ctx.items}
          draft={ctx.drafts[item.path]?.text}
          disabled={guidedDisabled(ctx, item)}
          publicBaseUrl={ctx.publicBaseUrl}
          onDraft={(text) => ctx.setDraft(item.path, text)}
          onDrop={() => ctx.dropDraft(item.path)}
        />
      ))}
    </div>
  );
}

export function ExpertLink({
  href,
  label,
  onNavigate,
  className,
  testId,
}: {
  href: string;
  label: string;
  onNavigate(href: string): void;
  className?: string;
  testId: string;
}) {
  return (
    <a
      href={absolute(href)}
      className={cn(
        "inline-flex items-center gap-1 text-sm font-medium underline-offset-2 hover:underline",
        className,
      )}
      data-testid={testId}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        onNavigate(href);
      }}
    >
      {label}
      <ChevronRight aria-hidden="true" className="size-4" />
    </a>
  );
}
