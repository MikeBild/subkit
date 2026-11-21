import { UiProvider } from "@ui/lib/ui-context";
import { Bug, Settings as SettingsIcon } from "lucide-react";
import { useEffect } from "react";
import { type SignInStore, SignInStoreProvider, useSignIn } from "../adapter/index.ts";
import { Connect } from "../features/connect/index.ts";
import { Consent, Invitation, Welcome, WorkspaceChoice } from "../features/first-run/index.ts";
import { Settings } from "../features/settings/index.ts";
import { DeviceRegistered, Relogin, SignIn } from "../features/sign-in/index.ts";
import { Button, OnboardingFrame, StepDots } from "../ui/index.ts";

function Window() {
  const { view, main, t, dispatch } = useSignIn();
  const locale = main?.locale ?? "en";
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  if (!view || !main) return null;
  const { screen, frame } = view;
  const toggle = t(frame.settingsOpen ? "settings.back" : "settings.open");
  return (
    <UiProvider lang={locale}>
      <OnboardingFrame
        brand={t("app.name")}
        actions={
          <>
            <Button
              data-testid="window-report"
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "ReportProblem" })}
            >
              <Bug className="size-4" aria-hidden />
              {t("common.report")}
            </Button>
            <Button
              data-testid="window-settings"
              variant="ghost"
              size="sm"
              className="w-8 px-0"
              aria-label={toggle}
              title={toggle}
              aria-pressed={frame.settingsOpen}
              onClick={() => dispatch({ type: "ToggleSettings" })}
            >
              <SettingsIcon className="size-4" aria-hidden />
            </Button>
          </>
        }
        dots={
          <StepDots
            visible={frame.dots.visible}
            current={frame.dots.current}
            total={frame.dots.total}
            label={t("common.step", { current: frame.dots.current + 1, total: frame.dots.total })}
          />
        }
        foot={t("app.version", { version: main.appVersion })}
      >
        {screen.kind === "welcome" && <Welcome />}
        {screen.kind === "invite" && <Invitation />}
        {screen.kind === "connect" && <Connect />}
        {screen.kind === "signin" && <SignIn />}
        {screen.kind === "workspace" && <WorkspaceChoice />}
        {screen.kind === "consent" && <Consent />}
        {screen.kind === "signed-in" && <DeviceRegistered />}
        {screen.kind === "relogin" && <Relogin />}
        {screen.kind === "settings" && <Settings />}
      </OnboardingFrame>
    </UiProvider>
  );
}

export function SignInWindow({ store }: { store: SignInStore }) {
  return (
    <SignInStoreProvider store={store}>
      <Window />
    </SignInStoreProvider>
  );
}
