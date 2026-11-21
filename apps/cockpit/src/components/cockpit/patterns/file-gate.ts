import { fileRefusal, formatBytes } from "@shared/file-kinds.ts";
import { reportFailure } from "@/lib/action-failure";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

export function useFileGate(limits: { accept?: string; maxBytes?: number }) {
  const { t, locale } = useI18n();
  return (files: readonly File[]): File[] =>
    files.filter((file) => {
      const refusal = fileRefusal(file, limits);
      if (refusal === "size" && limits.maxBytes !== undefined)
        reportFailure(
          t("platform.file.tooLarge", {
            name: file.name,
            max: formatBytes(limits.maxBytes, LOCALE_TAGS[locale]),
          }),
        );
      else if (refusal === "type") reportFailure(t("platform.file.wrongType", { name: file.name }));
      return refusal === null;
    });
}
