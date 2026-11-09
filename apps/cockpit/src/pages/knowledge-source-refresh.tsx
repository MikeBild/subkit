import type { components } from "@cli-core/engine-api/openapi";
import {
  Field,
  FieldDescription,
  FieldLabel,
  SegmentedControl,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { type RefreshRhythm, refreshRhythm } from "@/pages/knowledge-sources-model";

type KnowledgeSource = components["schemas"]["KnowledgeSource"];
type Translate = ReturnType<typeof useI18n>["t"];
export type OfferedRhythm = Exclude<RefreshRhythm, "custom">;

const RHYTHM_KEYS = {
  never: "knowledge.rhythm.never",
  daily: "knowledge.rhythm.daily",
  weekly: "knowledge.rhythm.weekly",
  custom: "knowledge.rhythm.custom",
} as const satisfies Record<RefreshRhythm, string>;

export function rhythmLabel(t: Translate, source: KnowledgeSource): string {
  const rhythm = refreshRhythm(source.refresh_strategy, source.refresh_cron);
  return rhythm === "custom" && source.refresh_cron
    ? `${t(RHYTHM_KEYS.custom)} (${source.refresh_cron})`
    : t(RHYTHM_KEYS[rhythm]);
}

export function RefreshField({
  value,
  onChange,
  current,
}: {
  value: OfferedRhythm | null;
  onChange(next: OfferedRhythm): void;
  current?: string;
}) {
  const { t } = useI18n();
  return (
    <Field>
      <FieldLabel>{t("knowledge.field.refresh")}</FieldLabel>
      <SegmentedControl
        label={t("knowledge.field.refresh")}
        value={value ?? ""}
        onValueChange={(next) => onChange(next as OfferedRhythm)}
        options={(["never", "daily", "weekly"] as const).map((rhythm) => ({
          value: rhythm,
          label: t(RHYTHM_KEYS[rhythm]),
          testId: `knowledge-refresh-${rhythm}`,
        }))}
        testId="knowledge-refresh-rhythm"
      />
      <FieldDescription>
        {current ? t("knowledge.rhythm.current", { rhythm: current }) : t("knowledge.rhythm.help")}
      </FieldDescription>
    </Field>
  );
}
