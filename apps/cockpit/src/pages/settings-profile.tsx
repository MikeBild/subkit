import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiCall } from "@/api/call";
import { absolute, peopleHref } from "@/app/links";
import { visibleNavigation } from "@/app/navigation";
import { useSession, useSessionUpdate } from "@/app/session";
import {
  DeviceNotificationSwitch,
  type NotificationDialogState,
  useDeviceNotifications,
} from "@/components/cockpit/installation-dialogs";
import {
  Button,
  FieldError,
  Input,
  SegmentedControl,
  StatusBadge,
  Switch,
} from "@/components/cockpit/patterns";
import { feedbackBridge } from "@/features/feedback/desktop-bridge";
import { type AppDeviceState, appDeviceState, runsInstalled } from "@/features/pwa/display-mode";
import { openInstall } from "@/features/pwa/install-store";
import { reportFailure } from "@/lib/action-failure";
import { type LocalePreference, useI18n } from "@/lib/i18n-context";
import { type Theme, useTheme } from "@/lib/theme";
import { roleName } from "@/pages/admin-model";
import { DevicesQuestion } from "@/pages/settings-devices";
import { Question } from "@/pages/settings-guided";
import { NAME_MAX } from "@/pages/welcome-model";

const PREFERENCES: readonly LocalePreference[] = ["auto", "de", "en"];
const THEMES: readonly Theme[] = ["system", "light", "dark"];

export function ProfileArea({
  name,
  nameInvalid,
  onName,
  disabled,
  navigate,
}: {
  name: string;
  nameInvalid: boolean;
  onName(text: string): void;
  disabled: boolean;
  navigate(href: string): void;
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
  const people = visibleNavigation(session.permissions)
    .flatMap((group) => group.items)
    .some((item) => item.path === "/people");
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
      device={device.state.bell ? device.state : null}
      onDevice={(checked) => void device.toggle(checked)}
      stepsShown={!session.start_steps.hidden}
      stepsPending={steps.isPending}
      onSteps={(shown) => steps.mutate(!shown)}
      devices={<DevicesQuestion />}
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
  device,
  onDevice,
  stepsShown,
  stepsPending,
  onSteps,
  devices,
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
  device: NotificationDialogState | null;
  onDevice(checked: boolean): void;
  stepsShown: boolean;
  stepsPending: boolean;
  onSteps(shown: boolean): void;
  devices?: ReactNode;
}) {
  const { t } = useI18n();
  const [beforeLink, afterLink = ""] = t("settings.profile.roleHelp").split("{link}");
  return (
    <div className="grid gap-5" data-testid="settings-area-profile">
      <Question
        title={t("settings.profile.name")}
        help={t("settings.profile.nameHelp")}
        testId="settings-question-profile-name"
      >
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
          <FieldError data-testid="settings-profile-name-error">
            {t("settings.profile.nameError")}
          </FieldError>
        ) : null}
      </Question>
      <Question
        title={t("settings.profile.email")}
        help={t("settings.profile.emailHelp")}
        testId="settings-question-profile-email"
      >
        <p className="text-sm [overflow-wrap:anywhere]" data-testid="settings-profile-email">
          {email}
        </p>
      </Question>
      <Question
        title={t("settings.profile.role")}
        help={
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
                {t("nav.people")}
              </a>
            ) : (
              t("nav.people")
            )}
            {afterLink}
          </>
        }
        testId="settings-question-profile-role"
      >
        <p className="text-sm" data-testid="settings-profile-role">
          {roleLabel}
        </p>
      </Question>
      <Question title={t("settings.profile.language")} testId="settings-question-profile-language">
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
      </Question>
      <Question title={t("settings.profile.theme")} testId="settings-question-profile-theme">
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
      </Question>
      {app ? (
        <Question title={t("settings.profile.app")} testId="settings-question-profile-app">
          <div
            className="flex min-h-8 flex-wrap items-center gap-2"
            role="status"
            data-testid="settings-profile-app-state"
            data-installed={app.installed ? "true" : "false"}
            data-notifications={app.notifications ? "true" : "false"}
          >
            <StatusBadge
              state={app.installed ? "ok" : "neutral"}
              label={t(app.installed ? "settings.profile.appInstalled" : "settings.profile.appNot")}
              testId="settings-profile-app-installed"
            />
            <StatusBadge
              state={app.notifications ? "ok" : "neutral"}
              label={t(
                app.notifications
                  ? "settings.profile.appNotifyOn"
                  : "settings.profile.appNotifyOff",
              )}
              testId="settings-profile-app-notifications"
            />
            {app.installable && onInstall ? (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={onInstall}
                data-testid="settings-profile-app-install"
              >
                {t("pwa.install.menu")}
              </Button>
            ) : null}
          </div>
        </Question>
      ) : null}
      {device ? (
        <Question title={t("settings.profile.device")} testId="settings-question-profile-device">
          <DeviceNotificationSwitch
            state={device}
            onToggle={onDevice}
            label={t("settings.profile.deviceSwitch")}
            hint={t("settings.profile.deviceHelp")}
          />
        </Question>
      ) : null}
      {devices}
      <Question title={t("settings.profile.steps")} testId="settings-question-profile-steps">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium">{t("settings.profile.stepsSwitch")}</p>
          <Switch
            checked={stepsShown}
            disabled={stepsPending}
            onCheckedChange={onSteps}
            aria-label={t("settings.profile.stepsSwitch")}
            data-testid="settings-profile-steps"
          />
        </div>
      </Question>
    </div>
  );
}
