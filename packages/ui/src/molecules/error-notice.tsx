import { Button } from "@ui/atoms/button";
import { type ErrorKind, techRows } from "@ui/lib/errors";
import { useI18n, useUi } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";
import { Bug, Check, ChevronDown, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";

export interface ErrorAction {
  label: string;
  onClick: () => void;
  testId?: string | undefined;
}

const part = (root: string | undefined, name: string) => (root ? `${root}-${name}` : undefined);

export function FieldError({
  id,
  children,
  testId,
}: {
  id?: string;
  children: ReactNode;
  testId?: string | undefined;
}) {
  return (
    <p id={id} role="alert" data-testid={testId} className="mt-2 text-sm text-destructive-ink">
      {children}
    </p>
  );
}

export function useErrorCopy(kind: ErrorKind): { title: string; body: string } {
  const { t } = useI18n();
  const { errors } = useUi();
  return errors.cases[kind]?.copy ?? t.err.unknown;
}

function useDetails(kind: ErrorKind, server?: string, at?: number) {
  const ui = useUi();
  const { t, fmt } = useI18n();
  const [shownAt] = useState(() => at ?? ui.now());
  return techRows({
    kind,
    at: at ?? shownAt,
    catalog: ui.errors,
    labels: t.err,
    fmt,
    server: server ?? ui.server,
  });
}

export interface TechDetailProps {
  kind: ErrorKind;
  server?: string | undefined;
  rows?: [string, string][] | undefined;
  at?: number | undefined;
  defaultOpen?: boolean | undefined;
  testId?: string | undefined;
  layout?: TechLayout | undefined;
  title?: string | undefined;
  report?: boolean | undefined;
}

export type TechLayout = "stacked" | "inline";

export function TechDetail({
  kind,
  server,
  rows: given,
  at,
  defaultOpen,
  testId,
  layout = "stacked",
  title,
  report = true,
}: TechDetailProps) {
  const { onReport } = useUi();
  const { t } = useI18n();
  const copy = useErrorCopy(kind);
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [copied, setCopied] = useState(false);
  const defaults = useDetails(kind, server, at);
  const rows = given ?? defaults;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const inline = layout === "inline";
  const copyLabel = copied ? t.err.copied : t.err.copy;
  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-3 h-8 text-muted-foreground"
        aria-expanded={open}
        data-testid={part(testId, "technical-toggle")}
        onClick={() => setOpen(!open)}
      >
        {t.err.tech}
        <ChevronDown
          className={cn("size-4 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </Button>
      {open && (
        <div
          className={cn("mt-2 rounded-lg bg-muted p-3", inline && "flex items-start gap-3")}
          data-testid={part(testId, "technical")}
          data-layout={layout}
        >
          <dl
            className={cn(
              "grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs",
              inline && "min-w-0 flex-1",
            )}
          >
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-all font-mono [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
          </dl>
          <div className={inline ? "-my-1 -mr-1 flex shrink-0 gap-1" : "mt-3 flex flex-wrap gap-2"}>
            <Button
              type="button"
              size={inline ? "icon" : "sm"}
              variant={inline ? "ghost" : "outline"}
              className={inline ? "size-8" : undefined}
              title={inline ? copyLabel : undefined}
              data-testid={part(testId, "technical-copy")}
              onClick={() => {
                void navigator.clipboard?.writeText(text).catch(() => undefined);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? (
                <Check className="size-4" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
              <span className={inline ? "sr-only" : undefined}>{copyLabel}</span>
            </Button>
            {onReport && report && (
              <Button
                type="button"
                size={inline ? "icon" : "sm"}
                variant={inline ? "ghost" : "outline"}
                className={inline ? "size-8" : undefined}
                title={inline ? t.err.report : undefined}
                data-testid={part(testId, "technical-report")}
                onClick={() => onReport(t.err.reportText(title ?? copy.title, text))}
              >
                <Bug className="size-4" aria-hidden />
                <span className={inline ? "sr-only" : undefined}>{t.err.report}</span>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorNotice({
  kind,
  primary,
  secondary,
  actions,
  server,
  tone = "danger",
  title,
  body,
  className,
  meta,
  rows,
  at,
  testId,
  layout,
  technical = true,
  titleSlot = "error-notice-title",
}: {
  kind: ErrorKind;
  primary?: ErrorAction | undefined;
  secondary?: ErrorAction | undefined;
  actions?: ReactNode;
  server?: string | undefined;
  tone?: "danger" | "warning";
  title?: ReactNode;
  body?: ReactNode;
  className?: string | undefined;
  meta?: ReactNode;
  rows?: [string, string][] | undefined;
  at?: number | undefined;
  testId?: string | undefined;
  layout?: TechLayout | undefined;
  technical?: boolean | undefined;
  titleSlot?: string | undefined;
}) {
  const c = useErrorCopy(kind);
  return (
    <div
      role="alert"
      data-slot="error-notice"
      data-tone={tone}
      data-state="error"
      data-testid={testId}
      className={cn("rounded-lg border px-3 py-2 text-left text-sm", className)}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn(
            "mt-[6px] size-2 shrink-0 rounded-full",
            tone === "danger" ? "bg-destructive" : "bg-amber-500",
          )}
        />
        <div className="min-w-0 flex-1">
          {meta && <p className="mb-1 truncate font-mono text-xs text-muted-foreground">{meta}</p>}
          <p className="font-semibold [overflow-wrap:anywhere]" data-slot={titleSlot}>
            {title ?? c.title}
          </p>
          <p className="mt-1 text-muted-foreground" data-slot="error-notice-body">
            {body ?? c.body}
          </p>
          {(primary || secondary || actions) && (
            <div className="mt-3 flex flex-wrap gap-2" data-slot="error-notice-actions">
              {primary && (
                <Button
                  type="button"
                  size="sm"
                  data-testid={primary.testId ?? part(testId, "primary")}
                  onClick={primary.onClick}
                >
                  {primary.label}
                </Button>
              )}
              {secondary && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={secondary.testId ?? part(testId, "secondary")}
                  onClick={secondary.onClick}
                >
                  {secondary.label}
                </Button>
              )}
              {actions}
            </div>
          )}
          {technical ? (
            <TechDetail
              kind={kind}
              server={server}
              rows={rows}
              at={at}
              testId={testId}
              layout={layout}
              title={typeof title === "string" ? title : undefined}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ErrorState({
  kind = "pageFailed",
  onRetry,
  onHome,
  rows,
  at,
  testId,
  layout,
  heading = "h1",
  retryTestId,
}: {
  kind?: ErrorKind;
  heading?: "h1" | "h2";
  retryTestId?: string | undefined;
  onRetry: () => void;
  onHome: () => void;
  rows?: [string, string][] | undefined;
  at?: number | undefined;
  testId?: string | undefined;
  layout?: TechLayout | undefined;
}) {
  const { t } = useI18n();
  const c = useErrorCopy(kind);
  const Heading = heading;
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mx-auto flex max-w-[480px] flex-col items-center py-16 text-center"
    >
      <span
        aria-hidden
        className="mb-4 flex size-16 items-center justify-center rounded-full bg-destructive/10"
      >
        <span className="size-3 rounded-full bg-destructive" />
      </span>
      <Heading className="text-xl font-semibold">{c.title}</Heading>
      <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button data-testid={retryTestId ?? part(testId, "retry")} onClick={onRetry}>
          {t.common.retry}
        </Button>
        <Button variant="outline" data-testid={part(testId, "home")} onClick={onHome}>
          {t.err.overview}
        </Button>
      </div>
      <div className="w-full text-left">
        <TechDetail kind={kind} rows={rows} at={at} testId={testId} layout={layout} />
      </div>
    </div>
  );
}
