import { Bug, Check, ChevronDown, Copy } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ApiError } from "@/api/transport";
import { Button } from "@/components/ui/button";
import { feedbackPrefillText } from "@/features/feedback/model";
import { openFeedback } from "@/features/feedback/store";
import { causeClassKey } from "@/lib/cause-class";
import { engineSentenceKey } from "@/lib/engine-sentence";
import { failureFacts } from "@/lib/failure-remedy";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { type ActionSpec, renderAction } from "./action-button";

export interface ErrorTechnicalRow {
  key: "code" | "http" | "request" | "time";
  value: string;
}

const ROW_LABEL: Record<ErrorTechnicalRow["key"], TranslationKey> = {
  code: "error.code",
  http: "error.http",
  request: "error.request",
  time: "error.time",
};

const MISSING = "–";

export function errorTechnicalRows(error: unknown, at: Date): ErrorTechnicalRow[] {
  const api = error instanceof ApiError ? error : null;
  const named = error instanceof Error && !api ? error.name : null;
  return [
    { key: "code", value: api?.code ?? named ?? MISSING },
    { key: "http", value: api && api.status > 0 ? String(api.status) : MISSING },
    { key: "request", value: api?.traceId ?? MISSING },
    { key: "time", value: at.toISOString() },
  ];
}

export function errorTechnicalText(
  rows: readonly ErrorTechnicalRow[],
  label: (key: ErrorTechnicalRow["key"]) => string,
): string {
  return rows.map((row) => `${label(row.key)}: ${row.value}`).join("\n");
}

function ErrorTechnical({
  error,
  title,
  testId,
}: {
  error: unknown;
  title: string;
  testId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [at] = useState(() => new Date());
  const region = useId();
  const rows = errorTechnicalRows(error, at);
  const text = errorTechnicalText(rows, (key) => t(ROW_LABEL[key]));
  const report = () => {
    const value = (key: ErrorTechnicalRow["key"]) => {
      const found = rows.find((row) => row.key === key)?.value;
      return found && found !== MISSING ? found : null;
    };
    const cause = failureFacts(error).causeClass;
    const causeKey = cause ? causeClassKey(cause) : undefined;
    return feedbackPrefillText(
      {
        title,
        cause: causeKey ? t(causeKey) : cause,
        code: value("code"),
        requestId: value("request"),
        at: value("time"),
      },
      {
        error: t("feedback.prefill.error"),
        cause: t("feedback.prefill.cause"),
        code: t("feedback.prefill.code"),
        request: t("feedback.prefill.request"),
        time: t("feedback.prefill.time"),
      },
    );
  };
  return (
    <div className="mt-2" data-slot="error-technical">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2.5 text-muted-foreground"
        aria-expanded={open}
        aria-controls={region}
        data-testid={`${testId}-technical-toggle`}
        onClick={() => setOpen((current) => !current)}
      >
        {t("error.technical")}
        <ChevronDown
          aria-hidden="true"
          className={cn("transition-transform duration-(--sk-dur-fast)", open && "rotate-180")}
        />
      </Button>
      {open ? (
        <div
          id={region}
          className="mt-2 rounded-lg bg-muted p-3"
          data-testid={`${testId}-technical`}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {rows.map((row) => (
              <div key={row.key} className="contents">
                <dt className="text-muted-foreground">{t(ROW_LABEL[row.key])}</dt>
                <dd className="min-w-0 break-all font-mono">{row.value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-36"
              data-testid={`${testId}-technical-copy`}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(text)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {t(copied ? "error.copied" : "error.copy")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`${testId}-technical-report`}
              onClick={() => openFeedback({ kind: "bug", text: report() })}
            >
              <Bug aria-hidden="true" />
              {t("error.report")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function errorSentence(error: unknown, t: (key: TranslationKey) => string): string | null {
  if (error === undefined || error === null) return null;
  const facts = failureFacts(error);
  const key = engineSentenceKey({ code: facts.code, cause_class: facts.causeClass });
  return key ? t(key) : null;
}

export function ErrorNotice({
  title,
  body,
  remedy,
  secondary,
  error,
  tone = "error",
  meta,
  testId = "error-notice",
  className,
  titleSlot,
  children,
}: {
  title: ReactNode;
  body?: ReactNode;
  remedy?: ReactNode | ActionSpec;
  secondary?: ReactNode;
  error?: unknown;
  tone?: "error" | "warn";
  meta?: ReactNode;
  testId?: string;
  className?: string;
  titleSlot?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      data-slot="error-notice"
      data-tone={tone}
      data-testid={testId}
      data-family-slot="data-state"
      data-family-state="error"
      data-state="error"
      className={cn("rounded-lg border px-3 py-2 text-left text-sm", className)}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            tone === "error" ? "bg-destructive" : "bg-amber-500",
          )}
        />
        <div className="min-w-0 flex-1">
          {meta ? (
            <p className="mb-1 truncate font-mono text-xs text-muted-foreground">{meta}</p>
          ) : null}
          <p
            className="font-semibold [overflow-wrap:anywhere]"
            data-slot={titleSlot ?? "error-notice-title"}
          >
            {title}
          </p>
          <p className="mt-1 text-muted-foreground" data-slot="error-notice-body">
            {body ?? errorSentence(error, t) ?? t("error.unchanged")}
          </p>
          {remedy || secondary || children ? (
            <div className="mt-3 flex flex-wrap gap-2" data-slot="error-notice-actions">
              {remedy ? renderAction(remedy) : null}
              {secondary}
              {children}
            </div>
          ) : null}
          {error === undefined || error === null ? null : (
            <ErrorTechnical
              error={error}
              title={typeof title === "string" ? title : t("error.loadFailed")}
              testId={testId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
