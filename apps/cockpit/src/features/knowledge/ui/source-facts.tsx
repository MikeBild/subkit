import { formatBytes } from "@shared/file-kinds.ts";
import { CopyField } from "@/components/cockpit/patterns/copy-field";
import type { SourceView } from "@/features/knowledge/model/knowledge";
import { sourceSizeText } from "@/features/knowledge/model/source-detail-model";
import { SOURCE_KIND_KEY } from "@/features/knowledge/model/source-list-model";
import { humanizeCategory } from "@/features/workflows/model";
import type { I18nValue } from "@/lib/i18n-context";
import { plural } from "@/lib/plural";
import type { KnowledgeSource } from "../hooks/use-source";
import type { DetailFact } from "../shell";

export function sourceFacts(
  src: KnowledgeSource,
  v: SourceView,
  { t, dateTime, locale }: Pick<I18nValue, "t" | "dateTime" | "locale">,
): DetailFact[] {
  return [
    { label: t("kn.fact.ref"), value: `@source:${src.slug}`, mono: true },
    ...(v.url
      ? [
          {
            label: t("kn.fact.address"),
            value: <CopyField value={v.url} label={t("kn.fact.address")} />,
          },
        ]
      : []),
    { label: t("kn.col.kind"), value: t(SOURCE_KIND_KEY[v.kind]) },
    {
      label: t("kn.sources.col.size"),
      value: sourceSizeText(
        plural(t, "kn.sources.sections", v.sections),
        typeof src.bytes_total === "number" ? formatBytes(src.bytes_total, locale) : null,
      ),
    },
    ...(src.mime_type ? [{ label: t("kn.files.format"), value: src.mime_type, mono: true }] : []),
    { label: t("kn.fact.version"), value: `v${src.version}` },
    {
      label: t("kn.col.category"),
      value: humanizeCategory(src.category, t("catalog.categoryOther")),
    },
    { label: t("kn.fact.created"), value: dateTime(src.created_at) },
    { label: t("kn.fact.id"), value: src.id, mono: true },
  ];
}
