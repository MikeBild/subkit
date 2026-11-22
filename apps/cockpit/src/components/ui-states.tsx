import type { HTMLAttributes, ReactNode } from "react";

type UiStateName =
  | "loading"
  | "empty"
  | "ready"
  | "partial"
  | "error"
  | "forbidden"
  | "stale"
  | "unknown"
  | "contract-mismatch";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type PageSectionProps = HTMLAttributes<HTMLElement> & {
  slot: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

export function PageSection({
  slot,
  title,
  description,
  actions,
  className,
  children,
  ...props
}: PageSectionProps) {
  return (
    <section data-sk-slot={slot} className={classes("min-w-0", className)} {...props}>
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

type StatePanelProps = HTMLAttributes<HTMLDivElement> & {
  state: Exclude<UiStateName, "ready">;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
};

export function StatePanel({
  state,
  title,
  description,
  action,
  className,
  ...props
}: StatePanelProps) {
  return (
    <div
      data-sk-state={state}
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

type FailurePanelContent = {
  title: ReactNode;
  description: ReactNode;
  icon: ReactNode;
};

type FailurePanelProps = HTMLAttributes<HTMLElement> &
  FailurePanelContent &
  (
    | {
        kind: "not-found" | "fatal-error";
        primaryAction: ReactNode;
        secondaryAction?: ReactNode;
        standalone?: boolean;
      }
    | { kind: "forbidden" }
  );

function ForbiddenPanel({
  title,
  description,
  icon,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & FailurePanelContent) {
  return (
    <div
      data-sk-failure-kind="forbidden"
      data-sk-state="forbidden"
      data-sk-slot="data-state"
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

export function FailurePanel(props: FailurePanelProps) {
  if (props.kind === "forbidden") {
    const { kind: _kind, ...rest } = props;
    return <ForbiddenPanel {...rest} />;
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
      data-sk-surface={kind}
      data-sk-failure-kind={kind}
      data-sk-state={fatal ? "error" : "empty"}
      data-testid={kind === "not-found" ? "not-found" : "fatal-error"}
      className={classes(
        "grid w-full min-w-0 flex-1 place-items-center px-4 py-10 sm:px-8",
        standalone ? "min-h-full bg-background" : "min-h-[calc(100dvh-3.5rem)]",
        className,
      )}
      {...rest}
    >
      <section
        data-sk-slot="failure-state"
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
          data-sk-slot="failure-actions"
          className="mt-6 flex flex-wrap items-center justify-center gap-2"
        >
          {primaryAction}
          {secondaryAction}
        </div>
      </section>
    </div>
  );
}

export function AuditMeta({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-sk-slot="audit-meta"
      className={classes("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
