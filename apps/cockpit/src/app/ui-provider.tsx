import { UiProvider } from "@ui/lib/ui-context";
import type { ReactNode } from "react";
import { openFeedback } from "@/features/feedback";
import { useI18n } from "@/lib/i18n-context";

const reportBug = (text: string) => openFeedback({ kind: "bug", text });

export function CockpitUiProvider({ children }: { children: ReactNode }) {
  const { locale, dateTime } = useI18n();
  return (
    <UiProvider
      lang={locale === "de" ? "de" : "en"}
      fmt={dateTime}
      server={typeof window === "undefined" ? undefined : window.location.origin}
      onReport={reportBug}
    >
      {children}
    </UiProvider>
  );
}
