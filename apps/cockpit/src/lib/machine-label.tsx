import type { Translate, TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

export interface CatalogLabel {
  text: string;
  machine: boolean;
}

export function catalogLabel(
  value: string,
  key: TranslationKey | undefined,
  t: Translate,
): CatalogLabel {
  return key ? { text: t(key), machine: false } : { text: value, machine: true };
}

export function EngineWording({ text, testId }: { text: string; testId?: string }) {
  const { t, locale } = useI18n();
  return (
    <span
      className="mt-1 block text-xs font-normal text-muted-foreground"
      data-engine-wording="true"
      data-testid={testId}
    >
      {locale === "en" ? null : <span>{t("common.engineWordingLabel")}: </span>}
      <span lang="en">{text}</span>
    </span>
  );
}

export function LabelText({ label }: { label: CatalogLabel }) {
  return label.machine ? (
    <code className="font-mono text-xs [overflow-wrap:anywhere]" data-machine-value="true">
      {label.text}
    </code>
  ) : (
    label.text
  );
}
