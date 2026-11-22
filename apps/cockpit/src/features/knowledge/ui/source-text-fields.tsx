import { FieldError } from "@ui/molecules/error-notice";
import { MarkdownEditor, type MarkdownRefs } from "@ui/organisms/markdown-editor";
import { Input, Label } from "@/components/cockpit/patterns/controls";
import { useI18n } from "@/lib/i18n-context";

export function SourceTextFields({
  name,
  onName,
  text,
  onText,
  tried,
  refs,
}: {
  name: string;
  onName: (name: string) => void;
  text: string;
  onText: (text: string) => void;
  tried: boolean;
  refs: MarkdownRefs;
}) {
  const { t } = useI18n();
  return (
    <>
      <div>
        <Label htmlFor="src-name">{t("kn.name")}</Label>
        <Input
          data-testid="src-name"
          id="src-name"
          className="mt-2"
          placeholder={t("kn.sources.namePh")}
          value={name}
          aria-invalid={(tried && !name.trim()) || undefined}
          onChange={(e) => onName(e.target.value)}
        />
        {tried && !name.trim() && <FieldError>{t("kn.sources.errName")}</FieldError>}
      </div>
      <div>
        <Label htmlFor="src-text" className="mb-2 block">
          {t("kn.content")}
        </Label>
        <MarkdownEditor
          id="src-text"
          value={text}
          onChange={onText}
          invalid={tried && !text.trim()}
          refs={refs}
        />
        {tried && !text.trim() && <FieldError>{t("kn.sources.errText")}</FieldError>}
      </div>
    </>
  );
}
