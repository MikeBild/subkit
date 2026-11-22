import { FieldError } from "@ui/molecules/error-notice";
import { Input, Label } from "@/components/cockpit/patterns/controls";
import type { Rhythm } from "@/features/knowledge/model/add-source-model";
import { useI18n } from "@/lib/i18n-context";
import { RhythmChips } from "./rhythm-chips";

export function SourceUrlFields({
  url,
  onUrl,
  invalid,
  rhythm,
  onRhythm,
}: {
  url: string;
  onUrl: (url: string) => void;
  invalid: boolean;
  rhythm: Rhythm;
  onRhythm: (r: Rhythm) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div>
        <Label htmlFor="src-url">{t("kn.sources.address")}</Label>
        <Input
          data-testid="src-url"
          id="src-url"
          className="mt-2 font-mono"
          value={url}
          aria-invalid={invalid || undefined}
          onChange={(e) => onUrl(e.target.value)}
        />
        {invalid && <FieldError>{t("kn.sources.errUrl")}</FieldError>}
      </div>
      <RhythmChips value={rhythm} onChange={onRhythm} />
    </>
  );
}
