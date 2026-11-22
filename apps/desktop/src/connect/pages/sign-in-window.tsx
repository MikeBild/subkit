import { errorCatalog } from "@shared/error-catalog.ts";
import { Button } from "@ui/atoms/button";
import { StepDots } from "@ui/atoms/step-dots";
import { UiProvider } from "@ui/lib/ui-context";
import { TooltipProvider } from "@ui/molecules/tooltip";
import { OnboardingFrame } from "@ui/templates/onboarding-frame";
import { Bug, Settings as SettingsIcon, Workflow } from "lucide-react";
import { useEffect } from "react";
import {
  type LocalCapabilitiesPort,
  LocalCapabilitiesProvider,
  type SignInStore,
  SignInStoreProvider,
  useSignIn,
} from "../adapter/index.ts";
import { Connect } from "../features/connect/index.ts";
import { Consent, Invitation, Welcome, WorkspaceChoice } from "../features/first-run/index.ts";
import { LocalCapabilities } from "../features/local-capabilities/index.ts";
import { LocalSetup } from "../features/local-setup/index.ts";
import { PermissionSetup } from "../features/permissions/index.ts";
import { Settings } from "../features/settings/index.ts";
import { DeviceRegistered, Relogin, SignIn } from "../features/sign-in/index.ts";

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
    <UiProvider lang={locale} mark={Workflow} appName="SubKit" errors={errorCatalog(locale)}>
      <TooltipProvider>
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
          {screen.kind === "local" && <LocalSetup />}
          {screen.kind === "signin" && <SignIn />}
          {screen.kind === "workspace" && <WorkspaceChoice />}
          {screen.kind === "consent" && <Consent />}
          {screen.kind === "signed-in" && <DeviceRegistered />}
          {screen.kind === "relogin" && <Relogin />}
          {screen.kind === "settings" && <Settings />}
          {screen.kind === "permissions" && <PermissionSetup />}
          {screen.kind === "local-capabilities" && (
            <LocalCapabilities
              device={screen.device}
              signedIn={screen.signedIn}
              supported={screen.supported}
            />
          )}
        </OnboardingFrame>
      </TooltipProvider>
    </UiProvider>
  );
}

export function SignInWindow({
  store,
  local,
}: {
  store: SignInStore;
  local: LocalCapabilitiesPort;
}) {
  return (
    <SignInStoreProvider store={store}>
      <LocalCapabilitiesProvider port={local}>
        <Window />
      </LocalCapabilitiesProvider>
    </SignInStoreProvider>
  );
}
