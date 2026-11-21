import { ErrorNotice, FieldError } from "@ui/components/proto/ErrorNotice";
import { Panel, Pill } from "@ui/components/proto/Pill";
import { useUi } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";
import { Bell, CalendarDays, Globe, Moon, Siren, Terminal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useSetup } from "@/api/setup";
import { useSession } from "@/app/session";
import {
  type NotificationDialogState,
  useDeviceNotifications,
} from "@/components/cockpit/installation-dialogs";
import {
  Button,
  CollapsibleSection,
  Input,
  Label,
  Switch,
  TimezoneSelect,
} from "@/components/cockpit/patterns";
import { answersFromSetup, toggleDay, useScheduleSave, WEEKDAYS } from "@/features/setup";
import { errorRows } from "@/lib/error-rows";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { browserTimeZone } from "@/lib/timezones";
import { useDesktopSettings } from "./desktop-settings";
import {
  type ApproverState,
  approvalsTo,
  type NotificationChange,
  type NotificationView,
  notificationChange,
  notificationView,
  quietNow,
  type TerminalQuiet,
  terminalQuietError,
} from "./notifications-model";
import { PauseRow } from "./pause-row";
import { Row } from "./row";
import { usePauseControl } from "./use-notification-pause";
import { useTerminalQuiet } from "./use-terminal-quiet";

function Clock({
  id,
  label,
  value,
  disabled,
  onCommit,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
  testId: string;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="time"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        className="mt-1 w-32 font-mono"
        data-testid={testId}
      />
    </div>
  );
}

function TerminalQuietRow({ tenant, canWrite }: { tenant: string; canWrite: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const terminal = useTerminalQuiet(tenant, true);
  const [error, setError] = useState<TranslationKey | null>(null);
  if (!terminal.value) return null;
  const current = terminal.value;
  const edit = (change: Partial<TerminalQuiet>) => {
    const next = { ...current, ...change };
    const problem = terminalQuietError(next);
    setError(problem);
    if (!problem) terminal.save(next);
  };
  const busy = !canWrite || terminal.saving;
  return (
    <Row
      icon={Terminal}
      label={t("settings.question.notifications.quiet")}
      hint={t("settings.question.notifications.quietHelp")}
      testId="settings-notification-terminal"
      below={
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-4">
            <Clock
              key={`tf-${current.from}`}
              id={`${id}-from`}
              label={t("setup.from")}
              value={current.from}
              disabled={busy}
              onCommit={(from) => edit({ from })}
              testId="settings-notification-terminal-from"
            />
            <Clock
              key={`tu-${current.until}`}
              id={`${id}-until`}
              label={t("setup.until")}
              value={current.until}
              disabled={busy}
              onCommit={(until) => edit({ until })}
              testId="settings-notification-terminal-until"
            />
          </div>
          {error && (
            <FieldError testId="settings-notification-terminal-error">{t(error)}</FieldError>
          )}
          {terminal.saveError && (
            <ErrorNotice
              testId="settings-notification-terminal-failed"
              kind="settingNotSaved"
              title={t("setup.saveFailed")}
              body={t("setup.saveFailedBody")}
              primary={{ label: t("pattern.retry"), onClick: terminal.retry }}
              rows={errorRows(terminal.saveError, t)}
            />
          )}
        </div>
      }
    />
  );
}

export function Notifications({
  terminal,
  more,
}: {
  terminal?: { tenant: string; canWrite: boolean } | null;
  more?: ReactNode;
}) {
  const { now } = useUi();
  const session = useSession();
  const setup = useSetup();
  const device = useDeviceNotifications(true);
  const schedule = useScheduleSave();
  const pause = usePauseControl();
  const desktop = useDesktopSettings();
  const [error, setError] = useState<TranslationKey | null>(null);
  if (!setup.data) return null;
  const answers = answersFromSetup(setup.data);
  const n = notificationView(answers);
  const zone = n.timezone ?? session.tenant.timezone ?? browserTimeZone();
  return (
    <NotificationsPanel
      n={n}
      zone={zone}
      quietActive={quietNow(n, new Date(now()), zone)}
      device={
        desktop
          ? { bell: true, checked: desktop.settings.notifications, disabled: false, note: "hint" }
          : device.state.bell
            ? device.state
            : null
      }
      onDevice={(c) => (desktop ? desktop.change({ notifications: c }) : void device.toggle(c))}
      pause={<PauseRow control={pause} when="paused" />}
      pauseOptions={<PauseRow control={pause} when="running" />}
      more={more}
      terminal={
        terminal ? <TerminalQuietRow tenant={terminal.tenant} canWrite={terminal.canWrite} /> : null
      }
      approvals={approvalsTo(
        setup.data.approver as ApproverState,
        session.principal.display_name || session.principal.email || "",
      )}
      busy={schedule.saving}
      error={error}
      saveError={schedule.saveError}
      onRetry={schedule.retry}
      onChange={(change) => {
        const next = notificationChange(answers, change);
        setError(next.error);
        if (next.update) schedule.save(next.update);
      }}
    />
  );
}

export function NotificationsPanel({
  n,
  zone,
  quietActive,
  device,
  onDevice,
  pause,
  pauseOptions,
  terminal,
  more,
  defaultMoreOpen = false,
  approvals,
  busy,
  error,
  saveError,
  onRetry,
  onChange: setN,
}: {
  n: NotificationView;
  zone: string;
  quietActive: boolean;
  device: NotificationDialogState | null;
  onDevice: (checked: boolean) => void;
  pause?: ReactNode;
  pauseOptions?: ReactNode;
  terminal: ReactNode;
  more?: ReactNode;
  defaultMoreOpen?: boolean;
  approvals: string;
  busy: boolean;
  error: TranslationKey | null;
  saveError: unknown;
  onRetry: () => void;
  onChange: (change: NotificationChange) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="flex flex-col gap-3" data-testid="settings-notification-schedule">
      <Panel className="divide-y py-1">
        {device && (
          <Row
            id={`${id}-device`}
            icon={Bell}
            label={t("settings.notifications.on")}
            hint={
              device.note === "handledByApp"
                ? t("installation.notificationsHandledByApp")
                : t("settings.notifications.onHint")
            }
            testId="settings-notification-device"
          >
            <Switch
              id={`${id}-device`}
              checked={device.checked}
              disabled={device.disabled}
              onCheckedChange={onDevice}
              data-testid="device-notifications-switch"
            />
          </Row>
        )}
        {device?.note === "denied" && (
          <div className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <Pill tone="warning">{t("installation.notificationsDenied")}</Pill>
          </div>
        )}
        {pause}
        <Row
          id={`${id}-quiet`}
          icon={Moon}
          label={t("settings.notifications.quiet")}
          hint={t("settings.notifications.quietHint")}
          testId="settings-notification-quiet"
        >
          <Switch
            id={`${id}-quiet`}
            checked={n.quiet}
            disabled={busy}
            onCheckedChange={(c) => setN({ quiet: c })}
            data-testid="settings-notification-quiet-switch"
          />
        </Row>
        {n.quiet && (
          <div className="flex flex-wrap items-end gap-4 py-3">
            <Clock
              key={`from-${n.quietFrom}`}
              id={`${id}-q-from`}
              label={t("setup.from")}
              value={n.quietFrom}
              disabled={busy}
              onCommit={(quietFrom) => setN({ quietFrom })}
              testId="settings-notification-from"
            />
            <Clock
              key={`until-${n.quietUntil}`}
              id={`${id}-q-until`}
              label={t("setup.until")}
              value={n.quietUntil}
              disabled={busy}
              onCommit={(quietUntil) => setN({ quietUntil })}
              testId="settings-notification-until"
            />
            {quietActive && (
              <span data-testid="settings-notification-quiet-active">
                <Pill tone="info">{t("settings.notifications.quietActive")}</Pill>
              </span>
            )}
          </div>
        )}
        <Row
          id={`${id}-digest`}
          icon={Bell}
          label={t("setup.label.daily")}
          hint={n.digest ? t("settings.notifications.digestHint", { at: n.digestAt }) : undefined}
          testId="settings-notification-daily"
        >
          <div className="flex items-center gap-3">
            {n.digest && (
              <Input
                key={`at-${n.digestAt}`}
                type="time"
                aria-label={t("setup.at")}
                defaultValue={n.digestAt}
                disabled={busy}
                onBlur={(e) => e.target.value !== n.digestAt && setN({ digestAt: e.target.value })}
                className="w-32 font-mono"
                data-testid="settings-notification-at"
              />
            )}
            <Switch
              id={`${id}-digest`}
              checked={n.digest}
              disabled={busy}
              onCheckedChange={(c) => setN({ digest: c })}
              data-testid="settings-notification-daily-switch"
            />
          </div>
        </Row>
        <p
          className="py-3 text-sm text-muted-foreground"
          data-testid="settings-notification-approvals"
        >
          {t("settings.notifications.approvalsTo", {
            who: approvals,
          })}
        </p>
      </Panel>
      <CollapsibleSection
        label={t("settings.notifications.more")}
        defaultOpen={defaultMoreOpen}
        testId="settings-notification-more"
      >
        <div className="flex flex-col gap-4">
          <Panel className="divide-y py-1 empty:hidden">
            {pauseOptions}
            {n.quiet && (
              <Row
                icon={CalendarDays}
                label={t("settings.notifications.days")}
                hint={t("settings.notifications.daysHint")}
                testId="settings-notification-days-row"
                below={
                  <fieldset
                    className="flex flex-wrap gap-1.5"
                    aria-label={t("settings.notifications.days")}
                    data-testid="settings-notification-days"
                  >
                    {WEEKDAYS.map((day) => {
                      const on = n.days.includes(day);
                      return (
                        <Button
                          key={day}
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-pressed={on}
                          disabled={busy}
                          className={cn(
                            "w-11 rounded-full",
                            on && "border-accent bg-accent/10 hover:bg-accent/15",
                          )}
                          onClick={() => setN({ days: toggleDay(n.days, day) })}
                          data-testid={`settings-notification-day-${day}`}
                        >
                          {t(`setup.day.${day}`)}
                        </Button>
                      );
                    })}
                  </fieldset>
                }
              />
            )}
            {terminal}
            {n.scheduled && (
              <Row
                id={`${id}-critical`}
                icon={Siren}
                label={t("setup.critical")}
                hint={t("setup.criticalHelp")}
                testId="settings-notification-critical"
              >
                <Switch
                  id={`${id}-critical`}
                  checked={n.critical}
                  disabled={busy}
                  onCheckedChange={(critical) => setN({ critical })}
                  data-testid="settings-notification-critical-switch"
                />
              </Row>
            )}
            {n.scheduled && (
              <Row icon={Globe} label={t("setup.zone")} testId="settings-notification-zone">
                <div className="w-64">
                  <TimezoneSelect
                    value={zone}
                    onChange={(timezone) => setN({ timezone })}
                    label={t("setup.zone")}
                    disabled={busy}
                    testId="settings-notification-timezone"
                  />
                </div>
              </Row>
            )}
          </Panel>
          {more}
        </div>
      </CollapsibleSection>
      {error && <FieldError testId="settings-notification-error">{t(error)}</FieldError>}
      {saveError ? (
        <ErrorNotice
          testId="settings-notification-save-failed"
          kind="settingNotSaved"
          title={t("setup.saveFailed")}
          body={t("setup.saveFailedBody")}
          primary={{ label: t("pattern.retry"), onClick: onRetry }}
          rows={errorRows(saveError, t)}
        />
      ) : null}
    </div>
  );
}
