import { errorCatalog } from "@shared/error-catalog.ts";
import { UiProvider } from "@ui/lib/ui-context";
import { Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { ActionFailureHost, RemedyLinksProvider } from "@/components/cockpit/patterns";
import { openFeedback } from "@/features/feedback";
import { useI18n } from "@/lib/i18n-context";
import { failureRemedyHref } from "./failure-remedy-links";

const DIALOG_NOTICE = <ActionFailureHost className="mt-2" />;

const reportBug = (text: string) => openFeedback({ kind: "bug", text });

export function CockpitUiProvider({ children }: { children: ReactNode }) {
  const { locale, dateTime } = useI18n();
  return (
    <UiProvider
      lang={locale === "de" ? "de" : "en"}
      fmt={dateTime}
      server={typeof window === "undefined" ? undefined : window.location.origin}
      onReport={reportBug}
      mark={Workflow}
      appName="SubKit"
      dialogNotice={DIALOG_NOTICE}
      errors={errorCatalog(locale === "de" ? "de" : "en")}
    >
      <RemedyLinksProvider href={failureRemedyHref}>{children}</RemedyLinksProvider>
    </UiProvider>
  );
}
