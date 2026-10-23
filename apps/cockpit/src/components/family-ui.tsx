import type { HTMLAttributes, ReactNode } from "react";

export const FAMILY_UI_VERSION = "3.0";

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
  working: "max-w-[1440px]",
  workbench: "max-w-[1760px]",
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

type FamilyFailureContent = {
  title: ReactNode;
  description: ReactNode;
  icon: ReactNode;
};

type FamilyFailureStateProps = HTMLAttributes<HTMLElement> &
  FamilyFailureContent &
  (
    | {
        kind: "not-found" | "fatal-error";
        primaryAction: ReactNode;
        secondaryAction?: ReactNode;
        standalone?: boolean;
      }
    | { kind: "forbidden" }
  );

function FamilyForbiddenState({
  title,
  description,
  icon,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & FamilyFailureContent) {
  return (
    <div
      data-family-failure-kind="forbidden"
      data-family-state="forbidden"
      data-family-slot="data-state"
      className={classes(
        "flex min-h-11 min-w-0 items-start gap-3 rounded-lg border bg-card px-4 py-2.5 text-sm leading-5 text-foreground",
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="font-semibold" data-slot="failure-title">
          {title}
        </p>
        <p className="text-muted-foreground" data-slot="failure-description">
          {description}
        </p>
      </div>
    </div>
  );
}

export function FamilyFailureState(props: FamilyFailureStateProps) {
  if (props.kind === "forbidden") {
    const { kind: _kind, ...rest } = props;
    return <FamilyForbiddenState {...rest} />;
  }
  const {
    kind,
    title,
    description,
    icon,
    primaryAction,
    secondaryAction,
    standalone = false,
    className,
    ...rest
  } = props;
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
        standalone ? "min-h-full bg-background" : "min-h-[calc(100dvh-3.5rem)]",
        className,
      )}
      {...rest}
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
