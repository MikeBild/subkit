import { useI18n } from "@/lib/i18n-context";
import { type Head, useColumnChoice } from "../shell";

export function useSourceColumns() {
  const { t } = useI18n();
  const head: Head[] = [
    { label: t("kn.sources.col.source"), sort: "name" },
    { label: t("kn.col.status"), sort: "status" },
    { label: t("kn.col.kind"), sort: "kind" },
    { label: t("kn.sources.col.size"), sort: "sections", priority: "low" },
    { label: t("kn.sources.col.ingested"), sort: "ingested", priority: "low" },
  ];
  return { head, columns: useColumnChoice(head) };
}
