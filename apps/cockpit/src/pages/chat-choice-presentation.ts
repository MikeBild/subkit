import type { TranslationKey } from "@/lib/i18n";
import type { ChatChoice } from "./chat-choice";

/** Compatibility for the old, persisted preparation question. Values and authority stay intact. */
export function chatChoicePresentation(choice: ChatChoice, t: (key: TranslationKey) => string) {
  const legacy =
    choice.question ===
      "Die Engine verlangt ein Dry-Run-Preview, bevor der Draft gespeichert werden kann. Write-Schritte (call_generate, call_publish, call_accept) werden dabei gehalten und nicht ausgeführt. Wie soll ich vorgehen?" &&
    choice.options.length === 3 &&
    choice.options[0]?.value === "dryrun" &&
    choice.options[0]?.label === "Dry-Run durchführen" &&
    choice.options[1]?.value === "force" &&
    choice.options[1]?.label === "force_commit verwenden" &&
    choice.options[2]?.value === "cancel" &&
    choice.options[2]?.label === "Abbrechen";
  if (!legacy) return choice;
  return {
    ...choice,
    question: t("chat.choice.preparation.question"),
    options: choice.options.map((option) => ({
      ...option,
      label: t(`chat.choice.preparation.${option.value as "dryrun" | "force" | "cancel"}`),
      description: t(
        `chat.choice.preparation.${option.value as "dryrun" | "force" | "cancel"}Effect`,
      ),
    })),
  };
}
