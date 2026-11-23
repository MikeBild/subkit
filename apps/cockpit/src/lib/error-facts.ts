import { ApiError } from "@/api/transport";
import { causeClassKey } from "@/lib/cause-class";
import { engineSentenceKey } from "@/lib/engine-sentence";
import { failureFacts } from "@/lib/failure-remedy";
import type { Translate, TranslationKey } from "@/lib/i18n";
import { modelLimitExhausted, reportsFault } from "@/lib/remedy";

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

export function labelledTechnicalRows(error: unknown, at: Date, t: Translate): [string, string][] {
  const rows = errorTechnicalRows(error, at).map((row): [string, string] => [
    t(ROW_LABEL[row.key]),
    row.value,
  ]);
  const cause = failureFacts(error).causeClass;
  if (!cause) return rows;
  const key = causeClassKey(cause);
  return [[t("error.cause"), key ? t(key) : cause], ...rows];
}

export function errorReportable(error: unknown): boolean {
  return reportsFault(failureFacts(error).code);
}

export function technicalKind(error: unknown): string {
  return errorTechnicalRows(error, new Date(0))[0]?.value ?? MISSING;
}

export function errorSentence(error: unknown, t: Translate): string | null {
  if (error === undefined || error === null) return null;
  const facts = failureFacts(error);
  if (modelLimitExhausted(facts.code)) return t("chat.cause.provider_context_too_large");
  const key = engineSentenceKey({ code: facts.code, cause_class: facts.causeClass });
  return key ? t(key) : null;
}
