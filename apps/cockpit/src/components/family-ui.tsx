import type { HTMLAttributes, ReactNode } from "react";

export const FAMILY_UI_VERSION = "2.2";

export type FamilySurface =
  | "auth"
  | "not-found"
  | "fatal-error"
  | "overview"
  | "decisions"
  | "collection"
  | "detail"
  | "form"
  | "installation"
  | "audit";

export type FamilyStateName =
  | "loading"
  | "empty"
  | "ready"
  | "partial"
  | "error"
  | "forbidden"
  | "stale"
  | "unknown"
  | "contract-mismatch";

export type FamilyKpiValueState = "observed" | "zero" | "missing" | "stale" | "forbidden";

export type FamilyKpiSeverity = "critical" | "urgent" | "healthy" | "information" | "unknown";

type FamilyPageProps = HTMLAttributes<HTMLDivElement> & {
  surface: FamilySurface;
  measure?: "reading" | "working" | "workbench" | "wide";
};

const measures = {
  reading: "max-w-[780px]",
  working: "max-w-[1120px]",
  workbench: "max-w-[1280px]",
  wide: "max-w-none",
} as const;

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function FamilyPage({
  surface,
  measure = "working",
  className,
  children,
  ...props
}: FamilyPageProps) {
  return (
    <div
      data-family-surface={surface}
      data-family-contract-version={FAMILY_UI_VERSION}
      className={classes(
        "mx-auto flex w-full min-w-0 flex-col gap-6 px-4 py-6 sm:px-6",
        measures[measure],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type FamilyPageHeaderProps = HTMLAttributes<HTMLElement> & {
  title: ReactNode;
  description?: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
};

export function FamilyPageHeader({
  title,
  description,
  context,
  actions,
  className,
  ...props
}: FamilyPageHeaderProps) {
  return (
    <header
      data-family-slot="page-header"
      className={classes(
        "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        {context ? (
          <div className="mb-2 text-xs leading-4 text-muted-foreground">{context}</div>
        ) : null}
        <h1 className="text-2xl font-semibold leading-8 tracking-[-0.02em]">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type FamilySectionProps = HTMLAttributes<HTMLElement> & {
  slot: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

export function FamilySection({
  slot,
  title,
  description,
  actions,
  className,
  children,
  ...props
}: FamilySectionProps) {
  return (
    <section data-family-slot={slot} className={classes("min-w-0", className)} {...props}>
      {title || description || actions ? (
        <div className="mb-3 flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold leading-6">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

type FamilyStateProps = HTMLAttributes<HTMLDivElement> & {
  state: Exclude<FamilyStateName, "ready">;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
};

export function FamilyState({
  state,
  title,
  description,
  action,
  className,
  ...props
}: FamilyStateProps) {
  return (
    <div
      data-family-state={state}
      className={classes(
        "grid min-h-56 place-items-center rounded-lg border border-dashed bg-card px-6 py-10 text-center",
        state === "error" && "border-destructive/50",
        className,
      )}
      {...props}
    >
      <div className="max-w-md">
        <h3 className="text-sm font-semibold leading-5">{title}</h3>
        {description ? (
          <p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

type FamilyFailureStateProps = HTMLAttributes<HTMLElement> & {
  kind: "not-found" | "fatal-error";
  title: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  standalone?: boolean;
};

/**
 * The one family surface for a route that cannot continue.
 *
 * It deliberately renders one heading, one sentence and at most two exits.
 * Diagnostics belong in telemetry; an operator-facing failure state only says
 * what happened and what they can do next.
 */
export function FamilyFailureState({
  kind,
  title,
  description,
  icon,
  primaryAction,
  secondaryAction,
  standalone = false,
  className,
  ...props
}: FamilyFailureStateProps) {
  const fatal = kind === "fatal-error";
  return (
    <div
      data-family-surface={kind}
      data-family-contract-version={FAMILY_UI_VERSION}
      data-family-failure-kind={kind}
      data-family-state={fatal ? "error" : "empty"}
      data-testid={kind === "not-found" ? "not-found" : "fatal-error"}
      className={classes(
        "grid w-full min-w-0 flex-1 place-items-center px-4 py-10 sm:px-6",
        standalone ? "min-h-svh bg-background" : "min-h-[calc(100svh-3.5rem)]",
        className,
      )}
      {...props}
    >
      <section
        data-family-slot="failure-state"
        role={fatal ? "alert" : undefined}
        className="flex w-full max-w-md flex-col items-center text-center"
      >
        <div
          aria-hidden="true"
          className={classes(
            "grid size-11 place-items-center rounded-2xl border bg-card text-foreground",
            fatal && "border-destructive/40 bg-destructive/[0.06] text-destructive",
          )}
        >
          {icon}
        </div>
        <h1 className="mt-5 text-2xl font-semibold leading-8 tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 max-w-sm text-sm leading-5 text-muted-foreground">{description}</p>
        <div
          data-family-slot="failure-actions"
          className="mt-6 flex flex-wrap items-center justify-center gap-2"
        >
          {primaryAction}
          {secondaryAction}
        </div>
      </section>
    </div>
  );
}

export function FamilyCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={classes(
        "rounded-2xl border bg-card p-4 text-card-foreground shadow-none",
        className,
      )}
      {...props}
    />
  );
}

type FamilyKpiGridProps = HTMLAttributes<HTMLDivElement>;

export function FamilyKpiGrid({ className, ...props }: FamilyKpiGridProps) {
  return (
    <div
      data-family-slot="operational-core"
      className={classes("grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5", className)}
      {...props}
    />
  );
}

type FamilyKpiCardProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  id: string;
  label: ReactNode;
  value: ReactNode;
  valueRaw?: number | null;
  valueState: FamilyKpiValueState;
  severity: FamilyKpiSeverity;
  tooltip: ReactNode;
  href: string;
  linkLabel: ReactNode;
  icon: ReactNode;
  status?: ReactNode;
  primary?: boolean;
};

const severityClasses: Record<FamilyKpiSeverity, string> = {
  critical: "border-destructive/50 bg-destructive/[0.04]",
  urgent: "border-amber-500/50 bg-amber-500/[0.04]",
  healthy: "border-emerald-500/40 bg-emerald-500/[0.035]",
  information: "border-border bg-card",
  unknown: "border-border bg-muted/25",
};

export function FamilyKpiCard({
  id,
  label,
  value,
  valueRaw,
  valueState,
  severity,
  tooltip,
  href,
  linkLabel,
  icon,
  status,
  primary = false,
  className,
  ...props
}: FamilyKpiCardProps) {
  const tooltipId = `family-kpi-${id.replace(/[^a-z0-9_-]/gi, "-")}-help`;
  return (
    <article
      data-family-kpi-id={id}
      data-family-kpi-value-state={valueState}
      data-family-kpi-value={valueRaw ?? undefined}
      data-family-kpi-severity={severity}
      data-family-primary={primary ? "true" : undefined}
      className={classes(
        "group relative min-h-40 min-w-0 rounded-2xl border p-4 shadow-none transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 hover:border-foreground/25",
        severityClasses[severity],
        className,
      )}
      {...props}
    >
      <a
        href={href}
        data-family-kpi-link="true"
        data-testid={`family-kpi-${id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-open`}
        className="absolute inset-0 z-10 rounded-2xl outline-none"
        aria-label={typeof linkLabel === "string" ? linkLabel : undefined}
      >
        <span className="sr-only">{linkLabel}</span>
      </a>
      <div className="relative z-20 flex items-start justify-between gap-2 pointer-events-none">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium leading-5">
          <span aria-hidden="true" data-family-kpi-icon="true">
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </div>
        <div className="group/help pointer-events-auto relative">
          <button
            type="button"
            data-family-kpi-tooltip="true"
            data-testid={`family-kpi-${id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-help`}
            aria-describedby={tooltipId}
            aria-label={typeof label === "string" ? label : undefined}
            className="relative z-30 grid size-7 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true" className="text-xs font-semibold">
              ?
            </span>
          </button>
          <div
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none absolute right-0 top-9 z-40 hidden w-64 rounded-lg border bg-popover p-3 text-left text-xs font-normal leading-4 text-popover-foreground shadow-lg group-hover/help:block group-focus-within/help:block"
          >
            {tooltip}
          </div>
        </div>
      </div>
      <div className="mt-5 text-3xl font-semibold leading-9 tracking-[-0.03em]">{value}</div>
      {status ? <div className="mt-1 text-xs leading-4 text-muted-foreground">{status}</div> : null}
      <span
        aria-hidden="true"
        data-family-kpi-link-label="true"
        className={classes(
          "mt-4 inline-flex text-sm font-medium",
          primary
            ? "rounded-lg bg-primary px-3 py-1.5 text-primary-foreground"
            : "underline decoration-border underline-offset-4",
        )}
      >
        {linkLabel}
      </span>
    </article>
  );
}

type FamilyOperationalMetaProps = HTMLAttributes<HTMLDivElement> & {
  auditLink: ReactNode;
  snapshot: ReactNode;
};

export function FamilyOperationalMeta({
  auditLink,
  snapshot,
  className,
  ...props
}: FamilyOperationalMetaProps) {
  return (
    <div
      data-family-slot="audit-meta"
      className={classes(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-4 text-xs leading-4 text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span>{auditLink}</span>
      <span aria-hidden="true">·</span>
      <span>{snapshot}</span>
    </div>
  );
}

export function FamilyAuditLink({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-family-slot="audit-meta"
      className={classes("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export type FamilyCollectionTier = "primary" | "embedded";

export const FAMILY_PRIMARY_COLLECTION_CAPABILITIES =
  "search relevant-filters sort column-visibility result-count pagination url-state responsive-cards loading-state \u0065mpty-state error-state";

export const FAMILY_CARD_COLLECTION_CAPABILITIES =
  "search relevant-filters sort result-count pagination url-state responsive-cards loading-state \u0065mpty-state error-state";

type FamilyCollectionFrameProps = HTMLAttributes<HTMLElement> & {
  id: string;
  tier?: FamilyCollectionTier;
  state?: FamilyStateName;
  capabilities?: string;
};

export function FamilyCollectionFrame({
  id,
  tier = "primary",
  state = "ready",
  capabilities,
  className,
  ...props
}: FamilyCollectionFrameProps) {
  return (
    <section
      data-family-slot="list-surface"
      data-family-collection-id={id}
      data-family-collection-tier={tier}
      data-family-state={state}
      data-family-collection-capability={capabilities}
      className={classes("min-w-0", className)}
      {...props}
    />
  );
}

export function FamilyCollectionToolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-family-slot="collection-toolbar"
      className={classes("flex min-w-0 flex-wrap items-center justify-between gap-3", className)}
      {...props}
    />
  );
}

export function FamilyCollectionMeta({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-family-slot="collection-meta"
      className={classes(
        "flex min-w-0 flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function FamilyCollectionRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-family-collection-row="true" className={classes("min-w-0", className)} {...props} />
  );
}

export function FamilyCollectionMobileCard({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <article
      data-family-collection-mobile-card="true"
      className={classes(
        "min-w-0 rounded-2xl border bg-card p-4 text-card-foreground shadow-none",
        className,
      )}
      {...props}
    />
  );
}
