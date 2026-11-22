import { Button } from "@/components/cockpit/patterns/controls";
import { RHYTHMS, type Rhythm } from "@/features/knowledge/model/add-source-model";
import { useI18n } from "@/lib/i18n-context";

export function RhythmChips({
  value,
  onChange,
}: {
  value: Rhythm | null;
  onChange: (r: Rhythm) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="m-0 min-w-0">
      <legend className="text-sm font-medium">{t("kn.sources.schedule")}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {RHYTHMS.map((x) => (
          <Button
            data-testid="kn-sources-rhythm"
            key={x}
            type="button"
            size="sm"
            variant={value === x ? "secondary" : "outline"}
            aria-pressed={value === x}
            className="rounded-full"
            onClick={() => onChange(x)}
          >
            {t(`kn.sources.rhythm.${x}`)}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
