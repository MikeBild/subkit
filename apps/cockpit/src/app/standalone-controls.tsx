import { SegmentedControl } from "@ui/molecules/segmented-control";
import { Bug } from "lucide-react";
import { Button } from "@/components/cockpit/patterns/controls";
import { FEEDBACK_SEARCH_PARAM, FeedbackButton, FeedbackHost } from "@/features/feedback";
import type { Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type Theme, useTheme } from "@/lib/theme";
import { loginHref } from "./login-href";
import { useOptionalSession } from "./session-context";

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const LANGUAGES: readonly Locale[] = ["de", "en"];

export function StandaloneControls() {
  const { t, locale, setPreference } = useI18n();
  const { theme, setTheme } = useTheme();
  const session = useOptionalSession();
  return (
    <div className="flex items-center justify-end gap-2" data-testid="standalone-controls">
      <div className="hidden items-center gap-2 sm:flex">
        <SegmentedControl
          label={t("account.language")}
          value={locale}
          onValueChange={(next) => {
            const chosen = LANGUAGES.find((candidate) => candidate === next);
            if (chosen) setPreference(chosen);
          }}
          testId="standalone-language"
          options={LANGUAGES.map((value) => ({
            value,
            label: value.toUpperCase(),
            testId: `standalone-language-${value}`,
          }))}
        />
        <SegmentedControl
          label={t("account.theme")}
          value={theme}
          onValueChange={(next) => {
            const chosen = THEMES.find((candidate) => candidate === next);
            if (chosen) setTheme(chosen);
          }}
          testId="standalone-theme"
          options={THEMES.map((value) => ({
            value,
            label: t(`account.theme.${value}`),
            testId: `standalone-theme-${value}`,
          }))}
        />
      </div>
      {session ? (
        <>
          <FeedbackButton />
          <FeedbackHost pathname={window.location.pathname} search={window.location.search} />
        </>
      ) : (
        <Button asChild variant="ghost" className="max-[479px]:w-10 max-[479px]:px-0">
          <a
            href={loginHref({ pathname: "/cockpit", search: `?${FEEDBACK_SEARCH_PARAM}=1` })}
            data-testid="feedback-open"
          >
            <Bug aria-hidden="true" />
            <span className="max-[479px]:sr-only">{t("feedback.entry")}</span>
          </a>
        </Button>
      )}
    </div>
  );
}
