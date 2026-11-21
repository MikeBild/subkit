import { errorFacts } from "@/lib/failure-remedy";
import type { Translate } from "@/lib/i18n";

export function errorRows(error: unknown, t: Translate): [string, string][] {
  const { code, status, traceId } = errorFacts(error);
  return [
    ...(code ? [[t("errorRows.code"), code] as [string, string]] : []),
    ...(status !== null ? [[t("errorRows.status"), String(status)] as [string, string]] : []),
    ...(traceId ? [[t("errorRows.request"), traceId] as [string, string]] : []),
  ];
}
