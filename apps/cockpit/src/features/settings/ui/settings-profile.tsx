import { useMutation } from "@tanstack/react-query";
import { Panel, Pill } from "@ui/atoms/pill";
import { FieldError } from "@ui/molecules/error-notice";
import { SettingsRow } from "@ui/molecules/settings-row";
import { AppWindow, Globe, ListChecks, Mail, Palette, ShieldCheck, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { apiCall } from "@/api/call";
import { absolute, peopleHref } from "@/app/links";
import { useSession, useSessionUpdate } from "@/app/session";
import { Button, Input, SegmentedControl, Switch } from "@/components/cockpit/patterns";
import { roleName } from "@/features/admin";
import { feedbackBridge } from "@/features/feedback";
import {
  type AppDeviceState,
  appDeviceState,
  openInstall,
  runsInstalled,
  useDeviceNotifications,
} from "@/features/pwa";
import { NAME_MAX } from "@/features/setup";
import { reportFailure } from "@/lib/action-failure";
import { type LocalePreference, useI18n } from "@/lib/i18n-context";
import { type Theme, useTheme } from "@/lib/theme";
import { visibleSettingAreas } from "../model/settings-areas";

const PREFERENCES: readonly LocalePreference[] = ["auto", "de", "en"];
const THEMES: readonly Theme[] = ["system", "light", "dark"];

export function ProfileArea({
  name,
  nameInvalid,
  onName,
  disabled,
  navigate,
  extra,
}: {
  name: string;
  nameInvalid: boolean;
  onName(text: string): void;
  disabled: boolean;
  navigate(href: string): void;
  extra?: ReactNode;
}) {
  const { t, preference, setPreference } = useI18n();
  const session = useSession();
  const update = useSessionUpdate();
  const { theme, setTheme } = useTheme();
  const device = useDeviceNotifications(true);
  const steps = useMutation({
    mutationFn: (hidden: boolean) =>
      apiCall("patch", "/v1/identity/me", { body: { start_steps_hidden: hidden } }),
    onMutate: (hidden) => showSteps(!hidden),
    onError: (_error, hidden) => {
      showSteps(hidden);
      reportFailure(t("common.actionFailed"));
    },
  });
  function showSteps(shown: boolean) {
    update.patch((current) => ({
      ...current,
      start_steps: { ...current.start_steps, hidden: !shown },
    }));
  }
  const people = visibleSettingAreas({
    permissions: session.permissions,
    isOwner: session.principal.is_owner,
    origin: session.tenant.origin,
  }).includes("people");
  return (
    <ProfileQuestions
      name={name}
      nameInvalid={nameInvalid}
      onName={onName}
      disabled={disabled}
      email={session.principal.email ?? ""}
      roleLabel={roleName(session.principal.role_name ?? "member", undefined, t).text}
      peopleHref={people ? peopleHref() : null}
      navigate={navigate}
      preference={preference}
      onPreference={setPreference}
      theme={theme}
      onTheme={setTheme}
      app={appDeviceState({
        installed: runsInstalled(),
        desktop: feedbackBridge() !== null,
        secure: typeof window !== "undefined" && window.isSecureContext,
        notifications: device.state.checked,
      })}
      onInstall={openInstall}
      stepsShown={!session.start_steps.hidden}
      stepsPending={steps.isPending}
      onSteps={(shown) => steps.mutate(!shown)}
      extra={extra}
    />
  );
}

export function ProfileQuestions({
  name,
  nameInvalid,
  onName,
  disabled,
  email,
  roleLabel,
  peopleHref: people,
  navigate,
  preference,
  onPreference,
  theme,
  onTheme,
  app,
  onInstall,
  stepsShown,
  stepsPending,
  onSteps,
  extra,
}: {
  name: string;
  nameInvalid: boolean;
  onName(text: string): void;
  disabled: boolean;
  email: string;
  roleLabel: string;
  peopleHref: string | null;
  navigate(href: string): void;
  preference: LocalePreference;
  onPreference(preference: LocalePreference): void;
  theme: Theme;
  onTheme(theme: Theme): void;
  app?: AppDeviceState | null;
  onInstall?(): void;
  stepsShown: boolean;
  stepsPending: boolean;
  onSteps(shown: boolean): void;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const [beforeLink, afterLink = ""] = t("settings.profile.roleHelp").split("{link}");
  const roleHelp = (
    <>
      {beforeLink}
      {people ? (
        <a
          href={absolute(people)}
          className="font-medium text-foreground underline underline-offset-2"
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            navigate(people);
          }}
          data-testid="settings-profile-people"
        >
          {t("settings.area.people.title")}
        </a>
      ) : (
        t("settings.area.people.title")
      )}
      {afterLink}
    </>
  );
  return (
    <div className="grid gap-4" data-testid="settings-area-profile">
      <Panel className="divide-y py-1">
        <SettingsRow
          icon={Palette}
          label={t("settings.profile.theme")}
          testId="settings-question-profile-theme"
        >
          <SegmentedControl
            label={t("settings.profile.theme")}
            value={theme}
            onValueChange={(next) => {
              const chosen = THEMES.find((candidate) => candidate === next);
              if (chosen) onTheme(chosen);
            }}
            testId="settings-profile-theme"
            options={THEMES.map((value) => ({
              value,
              label: t(`account.theme.${value}`),
              testId: `settings-profile-theme-${value}`,
            }))}
          />
        </SettingsRow>
        <SettingsRow
          icon={Globe}
          label={t("settings.profile.language")}
          testId="settings-question-profile-language"
        >
          <SegmentedControl
            label={t("settings.profile.language")}
            value={preference}
            onValueChange={(next) => {
              const chosen = PREFERENCES.find((candidate) => candidate === next);
              if (chosen) onPreference(chosen);
            }}
            testId="settings-profile-language"
            options={[
              {
                value: "auto",
                label: t("account.language.auto"),
                testId: "settings-profile-language-auto",
              },
              {
                value: "de",
                label: t("language.native.de"),
                testId: "settings-profile-language-de",
              },
              {
                value: "en",
                label: t("language.native.en"),
                testId: "settings-profile-language-en",
              },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          icon={UserRound}
          label={t("settings.profile.name")}
          hint={t("settings.profile.nameHelp")}
          testId="settings-question-profile-name"
          below={
            <div className="grid w-full gap-1 sm:w-96">
              <Input
                value={name}
                maxLength={NAME_MAX}
                autoComplete="name"
                disabled={disabled}
                aria-label={t("settings.profile.name")}
                aria-invalid={nameInvalid || undefined}
                onChange={(event) => onName(event.target.value)}
                data-testid="settings-profile-name"
              />
              {nameInvalid ? (
                <FieldError>
                  <span data-testid="settings-profile-name-error">
                    {t("settings.profile.nameError")}
                  </span>
                </FieldError>
              ) : null}
            </div>
          }
        />
        <SettingsRow
          icon={Mail}
          label={t("settings.profile.email")}
          hint={t("settings.profile.emailHelp")}
          testId="settings-question-profile-email"
        >
          <span className="text-sm [overflow-wrap:anywhere]" data-testid="settings-profile-email">
            {email}
          </span>
        </SettingsRow>
        <SettingsRow
          icon={ShieldCheck}
          label={t("settings.profile.role")}
          hint={roleHelp}
          testId="settings-question-profile-role"
        >
          <span className="text-sm" data-testid="settings-profile-role">
            {roleLabel}
          </span>
        </SettingsRow>
        {app ? (
          <SettingsRow
            icon={AppWindow}
            label={t("settings.profile.app")}
            testId="settings-question-profile-app"
          >
            <span
              className="flex flex-wrap items-center gap-2"
              role="status"
              data-testid="settings-profile-app-state"
              data-installed={app.installed ? "true" : "false"}
              data-notifications={app.notifications ? "true" : "false"}
            >
              <span data-testid="settings-profile-app-installed">
                <Pill tone={app.installed ? "success" : "neutral"}>
                  {t(app.installed ? "settings.profile.appInstalled" : "settings.profile.appNot")}
                </Pill>
              </span>
              <span data-testid="settings-profile-app-notifications">
                <Pill tone={app.notifications ? "success" : "neutral"}>
                  {t(
                    app.notifications
                      ? "settings.profile.appNotifyOn"
                      : "settings.profile.appNotifyOff",
                  )}
                </Pill>
              </span>
              {app.installable && onInstall ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onInstall}
                  data-testid="settings-profile-app-install"
                >
                  {t("pwa.install.menu")}
                </Button>
              ) : null}
            </span>
          </SettingsRow>
        ) : null}
        <SettingsRow
          icon={ListChecks}
          label={t("settings.profile.steps")}
          testId="settings-question-profile-steps"
        >
          <Switch
            checked={stepsShown}
            disabled={stepsPending}
            onCheckedChange={onSteps}
            aria-label={t("settings.profile.stepsSwitch")}
            data-testid="settings-profile-steps"
          />
        </SettingsRow>
        {extra}
      </Panel>
    </div>
  );
}
