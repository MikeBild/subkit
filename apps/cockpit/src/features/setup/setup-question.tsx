import { FieldError } from "@ui/components/proto/ErrorNotice";
import { ServiceMark } from "@ui/components/proto/visual";
import { cn } from "@ui/lib/utils";
import {
  Bell,
  Check,
  FlaskConical,
  type LucideIcon,
  MessageSquare,
  Plug,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button, Input, SwitchField, TimezoneSelect } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { browserTimeZone } from "@/lib/timezones";
import {
  JOB_MARK,
  JOB_MAX,
  JOB_SERVICES,
  NOTIFY_MODES,
  OTHER,
  questionError,
  SERVICE_NAMES,
  SETUP_ENVIRONMENTS,
  SETUP_JOBS,
  SETUP_MODES,
  SETUP_QUESTIONS,
  SETUP_SERVICES,
  type SetupAnswers,
  type SetupQuestionId,
  setupApprovers,
  toggleDay,
  WEEKDAYS,
} from "./model";

export const SETUP_KEYS = SETUP_QUESTIONS;
export type SetupKey = SetupQuestionId;
export const SETUP_ICON: Record<SetupKey, LucideIcon> = {
  job: Sparkles,
  services: Plug,
  approver: ShieldCheck,
  chatMode: MessageSquare,
  env: FlaskConical,
  notify: Bell,
};

function Pill({
  on,
  onClick,
  children,
  check,
  disabled,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  check?: boolean;
  disabled: boolean;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-auto min-h-10 min-w-0 whitespace-normal rounded-full text-left",
        on && "border-accent bg-accent/10 text-foreground hover:bg-accent/15",
      )}
      data-testid={testId}
    >
      {check && (
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
            on ? "border-accent bg-accent text-accent-foreground" : "border-muted-foreground/40",
          )}
          aria-hidden
        >
          {on && <Check className="size-3" />}
        </span>
      )}
      {children}
    </Button>
  );
}

export function SetupQuestion({
  k,
  value,
  onDone,
  align = "end",
  disabled = false,
  offerPair = false,
}: {
  k: SetupKey;
  value: SetupAnswers;
  onDone: (v: SetupAnswers) => void;
  align?: "start" | "end";
  disabled?: boolean;
  offerPair?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<SetupAnswers>(value);
  const [err, setErr] = useState(false);
  const [browserZone] = useState(browserTimeZone);
  const zoneId = useId();
  const justify = align === "end" ? "justify-end" : "justify-start";
  const row = cn("flex flex-wrap gap-2", justify);
  const error = err ? questionError(k, draft) : null;
  const set = (p: Partial<SetupAnswers>) => {
    setErr(false);
    setDraft({ ...draft, ...p });
  };
  const finish = (v: SetupAnswers) => {
    if (questionError(k, v)) {
      setDraft(v);
      setErr(true);
    } else onDone(v);
  };
  const applyBtn = (v: SetupAnswers = draft) => (
    <Button
      type="button"
      className="h-10"
      disabled={disabled}
      onClick={() => finish(v)}
      data-testid={`setup-${k}-apply`}
    >
      {t("setup.apply")}
    </Button>
  );
  const time = (testId: string, label: string, v: string, on: (x: string) => void) => (
    <label className="flex items-center gap-2 text-sm" htmlFor={`${zoneId}-${testId}`}>
      <span className="text-muted-foreground">{label}</span>
      <Input
        id={`${zoneId}-${testId}`}
        type="time"
        value={v}
        disabled={disabled}
        onChange={(e) => on(e.target.value)}
        className="w-28 font-mono"
        data-testid={testId}
      />
    </label>
  );
  const extra = (node: ReactNode) => (
    <div className={cn("mt-2 flex flex-wrap items-start gap-2", justify)}>{node}</div>
  );
  const problem = error ? (
    <FieldError testId={`setup-${k}-error`}>
      <span className={cn("block", align === "end" && "text-right")}>{t(error)}</span>
    </FieldError>
  ) : null;
  switch (k) {
    case "job":
      return (
        <div data-testid="setup-job">
          <fieldset className={row} aria-label={t("setup.question.job")}>
            {SETUP_JOBS.map((j) => (
              <Pill
                key={j}
                on={draft.job === j}
                disabled={disabled}
                onClick={() => finish({ ...draft, job: j, services: [...JOB_SERVICES[j]] })}
                testId={`setup-job-${j}`}
              >
                <ServiceMark name={JOB_MARK[j] ? SERVICE_NAMES[JOB_MARK[j]] : "SubKit"} />
                {t(`setup.job.${j}`)}
              </Pill>
            ))}
            <Pill
              on={draft.job === OTHER}
              disabled={disabled}
              onClick={() => set({ job: OTHER })}
              testId="setup-job-other"
            >
              <ServiceMark name="SubKit" />
              {t("setup.job.other")}
            </Pill>
          </fieldset>
          {draft.job === OTHER &&
            extra(
              <>
                <div className="w-72">
                  <Input
                    aria-label={t("setup.otherLabel")}
                    placeholder={t("setup.otherLabel")}
                    value={draft.jobOther}
                    maxLength={JOB_MAX}
                    disabled={disabled}
                    onChange={(e) => set({ jobOther: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        finish({ ...draft, services: [] });
                      }
                    }}
                    aria-invalid={error ? true : undefined}
                    data-testid="setup-job-other-input"
                  />
                  {problem}
                </div>
                {applyBtn({ ...draft, services: [] })}
              </>,
            )}
        </div>
      );
    case "services":
      return (
        <div data-testid="setup-services">
          <fieldset className={row} aria-label={t("setup.question.services")}>
            {[...SETUP_SERVICES, OTHER].map((x) => {
              const on = draft.services.includes(x);
              return (
                <Pill
                  key={x}
                  check
                  on={on}
                  disabled={disabled}
                  onClick={() =>
                    set({
                      services: on ? draft.services.filter((y) => y !== x) : [...draft.services, x],
                    })
                  }
                  testId={`setup-service-${x}`}
                >
                  {x !== OTHER && (
                    <ServiceMark name={SERVICE_NAMES[x as keyof typeof SERVICE_NAMES]} />
                  )}
                  {x === OTHER
                    ? t("setup.service.other")
                    : SERVICE_NAMES[x as keyof typeof SERVICE_NAMES]}
                </Pill>
              );
            })}
          </fieldset>
          {extra(
            <>
              {problem}
              {applyBtn()}
            </>,
          )}
        </div>
      );
    case "approver":
      return (
        <div data-testid="setup-approver">
          <fieldset className={row} aria-label={t("setup.question.approver")}>
            {setupApprovers(offerPair).map((x) => (
              <Pill
                key={x}
                on={draft.approver === x}
                disabled={disabled}
                onClick={() =>
                  x === "self" ? finish({ ...draft, approver: x }) : set({ approver: x })
                }
                testId={`setup-approver-${x}`}
              >
                {t(`setup.approver.${x}`)}
              </Pill>
            ))}
          </fieldset>
          {draft.approver !== "self" &&
            extra(
              <>
                <div className="w-72">
                  <Input
                    type="email"
                    aria-label={t("setup.emailLabel")}
                    placeholder="anna@example.com"
                    autoComplete="off"
                    value={draft.approverEmail}
                    disabled={disabled}
                    onChange={(e) => set({ approverEmail: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        finish(draft);
                      }
                    }}
                    aria-invalid={error ? true : undefined}
                    data-testid="setup-approver-email"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{t("setup.role")}</p>
                  {problem}
                </div>
                {applyBtn()}
              </>,
            )}
        </div>
      );
    case "chatMode":
      return (
        <fieldset
          className={cn("flex flex-col gap-2", align === "end" ? "items-end" : "items-start")}
          aria-label={t("setup.question.chatMode")}
          data-testid="setup-chatMode"
        >
          {SETUP_MODES.map((x) => (
            <Pill
              key={x}
              on={draft.chatMode === x}
              disabled={disabled}
              onClick={() => finish({ ...draft, chatMode: x })}
              testId={`setup-chatMode-${x}`}
            >
              <span>
                <span className="block font-medium">
                  {t(`setup.mode.${x}`)}
                  {x === "auto" && (
                    <span className="font-normal text-muted-foreground">
                      {" · "}
                      {t("setup.recommended")}
                    </span>
                  )}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {t(`setup.modeHint.${x}`)}
                </span>
              </span>
            </Pill>
          ))}
        </fieldset>
      );
    case "env":
      return (
        <fieldset className={row} aria-label={t("setup.question.env")} data-testid="setup-env">
          {SETUP_ENVIRONMENTS.map((x) => (
            <Pill
              key={x}
              on={draft.env === x}
              disabled={disabled}
              onClick={() => finish({ ...draft, env: x })}
              testId={`setup-env-${x}`}
            >
              {t(`setup.env.${x}`)}
              {x === "dev" && (
                <span className="text-muted-foreground">· {t("setup.recommended")}</span>
              )}
            </Pill>
          ))}
        </fieldset>
      );
    case "notify": {
      const zone = draft.timezone ?? browserZone;
      return (
        <div data-testid="setup-notify">
          <fieldset className={row} aria-label={t("setup.question.notify")}>
            {NOTIFY_MODES.map((x) => (
              <Pill
                key={x}
                on={draft.notify === x}
                disabled={disabled}
                onClick={() =>
                  x === "immediately" ? finish({ ...draft, notify: x }) : set({ notify: x })
                }
                testId={`setup-notify-${x}`}
              >
                {t(`setup.notify.${x}`)}
              </Pill>
            ))}
          </fieldset>
          {draft.notify === "working_hours" &&
            extra(
              <>
                {time("setup-notify-from", t("setup.from"), draft.from, (v) => set({ from: v }))}
                {time("setup-notify-to", t("setup.until"), draft.to, (v) => set({ to: v }))}
                <fieldset
                  className={cn("flex w-full flex-wrap items-center gap-1.5", justify)}
                  aria-label={t("setup.days")}
                  data-testid="setup-notify-days"
                >
                  {WEEKDAYS.map((day) => (
                    <Pill
                      key={day}
                      check
                      on={draft.days.includes(day)}
                      disabled={disabled}
                      onClick={() => set({ days: toggleDay(draft.days, day) })}
                      testId={`setup-notify-day-${day}`}
                    >
                      {t(`setup.day.${day}`)}
                    </Pill>
                  ))}
                </fieldset>
              </>,
            )}
          {draft.notify === "daily_digest" &&
            extra(time("setup-notify-at", t("setup.at"), draft.at, (v) => set({ at: v })))}
          {draft.notify !== "immediately" &&
            extra(
              <div className="flex w-full flex-col gap-3 text-left sm:w-80">
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-muted-foreground" htmlFor={zoneId}>
                    {t("setup.zone")}
                  </label>
                  <TimezoneSelect
                    id={zoneId}
                    value={zone}
                    onChange={(timezone) => set({ timezone })}
                    label={t("setup.zone")}
                    disabled={disabled}
                    testId="setup-notify-timezone"
                  />
                </div>
                <SwitchField
                  label={t("setup.critical")}
                  help={t("setup.criticalHelp")}
                  checked={draft.critical}
                  disabled={disabled}
                  onChange={(critical) => set({ critical })}
                  testId="setup-notify-critical"
                />
              </div>,
            )}
          {draft.notify !== "immediately" &&
            extra(
              <>
                {problem}
                {applyBtn({ ...draft, timezone: zone })}
              </>,
            )}
        </div>
      );
    }
  }
}
