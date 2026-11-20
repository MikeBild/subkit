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
import {
  Button,
  FieldError,
  Input,
  SwitchField,
  TimezoneSelect,
} from "@/components/cockpit/patterns";
import { ServiceIcon, SubKitMark } from "@/components/cockpit/service-icon";
import { useI18n } from "@/lib/i18n-context";
import { serviceIdentity } from "@/lib/service-icons";
import { browserTimeZone } from "@/lib/timezones";
import { cn } from "@/lib/utils";
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
  SETUP_SERVICES,
  type SetupAnswers,
  type SetupQuestionId,
  toggleDay,
  WEEKDAYS,
} from "./setup-model";

export const SETUP_ICON: Readonly<Record<SetupQuestionId, LucideIcon>> = {
  job: Sparkles,
  services: Plug,
  approver: ShieldCheck,
  chatMode: MessageSquare,
  env: FlaskConical,
  notify: Bell,
};

function Option({
  selected,
  onSelect,
  disabled,
  check = false,
  testId,
  children,
}: {
  selected: boolean;
  onSelect(): void;
  disabled: boolean;
  check?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "h-auto min-h-10 whitespace-normal rounded-full px-3.5 py-2 text-left",
        selected && "border-foreground ring-1 ring-foreground",
      )}
      data-testid={testId}
    >
      {check ? (
        <span
          aria-hidden="true"
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-[4px] border",
            selected ? "border-foreground bg-foreground text-background" : "border-input",
          )}
        >
          {selected ? <Check className="size-3" /> : null}
        </span>
      ) : null}
      {children}
    </Button>
  );
}

function ClockField({
  label,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  testId: string;
}) {
  const id = useId();
  return (
    <label className="flex items-center gap-2 text-sm" htmlFor={id}>
      <span className="text-muted-foreground">{label}</span>
      <Input
        id={id}
        type="time"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-36 font-mono tabular-nums"
        data-testid={testId}
      />
    </label>
  );
}

export function SetupQuestion({
  id,
  value,
  onDone,
  align = "end",
  disabled = false,
}: {
  id: SetupQuestionId;
  value: SetupAnswers;
  onDone(answers: SetupAnswers): void;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<SetupAnswers>(value);
  const [checked, setChecked] = useState(false);
  const [browserZone] = useState(browserTimeZone);
  const zoneId = useId();
  const error = checked ? questionError(id, draft) : null;
  const set = (change: Partial<SetupAnswers>) => {
    setChecked(false);
    setDraft((current) => ({ ...current, ...change }));
  };
  const finish = (answers: SetupAnswers) => {
    if (questionError(id, answers)) {
      setDraft(answers);
      setChecked(true);
      return;
    }
    onDone(answers);
  };
  const justify = align === "end" ? "justify-end" : "justify-start";
  const row = cn("flex flex-wrap gap-2", justify);
  const apply = (
    <Button
      type="button"
      disabled={disabled}
      onClick={() => finish(draft)}
      data-testid={`setup-${id}-apply`}
    >
      {t("setup.apply")}
    </Button>
  );
  const extra = (children: ReactNode) => (
    <div className={cn("mt-2 flex flex-wrap items-start gap-2", justify)}>{children}</div>
  );
  const problem = error ? (
    <FieldError className="w-full" data-testid={`setup-${id}-error`}>
      <span className={cn("block", align === "end" && "text-right")}>{t(error)}</span>
    </FieldError>
  ) : null;

  if (id === "job")
    return (
      <div data-testid="setup-job">
        <fieldset className={row} aria-label={t("setup.question.job")}>
          {SETUP_JOBS.map((job) => {
            const mark = JOB_MARK[job];
            return (
              <Option
                key={job}
                selected={draft.job === job}
                disabled={disabled}
                onSelect={() => finish({ ...draft, job, services: [...JOB_SERVICES[job]] })}
                testId={`setup-job-${job}`}
              >
                {mark ? (
                  <ServiceIcon service={serviceIdentity({ slug: mark })} />
                ) : (
                  <SubKitMark tile={false} />
                )}
                {t(`setup.job.${job}`)}
              </Option>
            );
          })}
          <Option
            selected={draft.job === OTHER}
            disabled={disabled}
            onSelect={() => set({ job: OTHER })}
            testId="setup-job-other"
          >
            <SubKitMark tile={false} />
            {t("setup.job.other")}
          </Option>
        </fieldset>
        {draft.job === OTHER
          ? extra(
              <>
                <Input
                  aria-label={t("setup.otherLabel")}
                  placeholder={t("setup.otherLabel")}
                  value={draft.jobOther}
                  maxLength={JOB_MAX}
                  disabled={disabled}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => set({ jobOther: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    finish({ ...draft, services: [] });
                  }}
                  className="w-72"
                  data-testid="setup-job-other-input"
                />
                <Button
                  type="button"
                  disabled={disabled}
                  onClick={() => finish({ ...draft, services: [] })}
                  data-testid="setup-job-apply"
                >
                  {t("setup.apply")}
                </Button>
                {problem}
              </>,
            )
          : null}
      </div>
    );

  if (id === "services")
    return (
      <div data-testid="setup-services">
        <fieldset className={row} aria-label={t("setup.question.services")}>
          {[...SETUP_SERVICES, OTHER].map((slug) => {
            const selected = draft.services.includes(slug);
            return (
              <Option
                key={slug}
                check
                selected={selected}
                disabled={disabled}
                onSelect={() =>
                  set({
                    services: selected
                      ? draft.services.filter((service) => service !== slug)
                      : [...draft.services, slug],
                  })
                }
                testId={`setup-service-${slug}`}
              >
                {slug === OTHER ? null : <ServiceIcon service={serviceIdentity({ slug })} />}
                {slug === OTHER
                  ? t("setup.service.other")
                  : SERVICE_NAMES[slug as keyof typeof SERVICE_NAMES]}
              </Option>
            );
          })}
        </fieldset>
        {extra(
          <>
            {apply}
            {problem}
          </>,
        )}
      </div>
    );

  if (id === "approver")
    return (
      <div data-testid="setup-approver">
        <fieldset className={row} aria-label={t("setup.question.approver")}>
          <Option
            selected={draft.approver === "self"}
            disabled={disabled}
            onSelect={() => finish({ ...draft, approver: "self" })}
            testId="setup-approver-self"
          >
            {t("setup.approver.self")}
          </Option>
          <Option
            selected={draft.approver === "teammate"}
            disabled={disabled}
            onSelect={() => set({ approver: "teammate" })}
            testId="setup-approver-teammate"
          >
            {t("setup.approver.teammate")}
          </Option>
        </fieldset>
        {draft.approver === "teammate"
          ? extra(
              <>
                <span className="grid w-72 gap-1">
                  <Input
                    type="email"
                    aria-label={t("setup.emailLabel")}
                    placeholder="anna@example.com"
                    autoComplete="off"
                    value={draft.approverEmail}
                    disabled={disabled}
                    aria-invalid={error ? true : undefined}
                    onChange={(event) => set({ approverEmail: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      finish(draft);
                    }}
                    data-testid="setup-approver-email"
                  />
                  <span className="text-xs text-muted-foreground">{t("setup.role")}</span>
                </span>
                {apply}
                {problem}
              </>,
            )
          : null}
      </div>
    );

  if (id === "chatMode")
    return (
      <fieldset
        className={cn("flex flex-col gap-2", align === "end" ? "items-end" : "items-start")}
        aria-label={t("setup.question.chatMode")}
        data-testid="setup-chatMode"
      >
        {SETUP_MODES.map((mode) => (
          <Option
            key={mode}
            selected={draft.chatMode === mode}
            disabled={disabled}
            onSelect={() => finish({ ...draft, chatMode: mode })}
            testId={`setup-chatMode-${mode}`}
          >
            <span className="grid gap-0.5">
              <span className="font-medium">
                {t(`setup.mode.${mode}`)}
                {mode === "auto" ? (
                  <span className="font-normal text-muted-foreground">
                    {" · "}
                    {t("setup.recommended")}
                  </span>
                ) : null}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {t(`setup.modeHint.${mode}`)}
              </span>
            </span>
          </Option>
        ))}
      </fieldset>
    );

  if (id === "env")
    return (
      <fieldset className={row} aria-label={t("setup.question.env")} data-testid="setup-env">
        {SETUP_ENVIRONMENTS.map((environment) => (
          <Option
            key={environment}
            selected={draft.env === environment}
            disabled={disabled}
            onSelect={() => finish({ ...draft, env: environment })}
            testId={`setup-env-${environment}`}
          >
            {t(`setup.env.${environment}`)}
            {environment === "dev" ? (
              <span className="font-normal text-muted-foreground">
                {"· "}
                {t("setup.recommended")}
              </span>
            ) : null}
          </Option>
        ))}
      </fieldset>
    );

  const zone = draft.timezone ?? browserZone;
  return (
    <div data-testid="setup-notify">
      <fieldset className={row} aria-label={t("setup.question.notify")}>
        {NOTIFY_MODES.map((mode) => (
          <Option
            key={mode}
            selected={draft.notify === mode}
            disabled={disabled}
            onSelect={() =>
              mode === "immediately" ? finish({ ...draft, notify: mode }) : set({ notify: mode })
            }
            testId={`setup-notify-${mode}`}
          >
            {t(`setup.notify.${mode}`)}
          </Option>
        ))}
      </fieldset>
      {draft.notify === "immediately" ? null : (
        <div
          className={cn(
            "mt-3 grid gap-3",
            align === "end" ? "justify-items-end" : "justify-items-start",
          )}
          data-testid="setup-notify-schedule"
        >
          <div className={cn("flex flex-wrap items-center gap-2", justify)}>
            {draft.notify === "working_hours" ? (
              <>
                <ClockField
                  label={t("setup.from")}
                  value={draft.from}
                  disabled={disabled}
                  onChange={(from) => set({ from })}
                  testId="setup-notify-from"
                />
                <ClockField
                  label={t("setup.until")}
                  value={draft.to}
                  disabled={disabled}
                  onChange={(to) => set({ to })}
                  testId="setup-notify-to"
                />
                <fieldset
                  className="flex w-full flex-wrap items-center gap-1.5"
                  aria-label={t("setup.days")}
                  data-testid="setup-notify-days"
                >
                  {WEEKDAYS.map((day) => (
                    <Option
                      key={day}
                      check
                      selected={draft.days.includes(day)}
                      disabled={disabled}
                      onSelect={() => set({ days: toggleDay(draft.days, day) })}
                      testId={`setup-notify-day-${day}`}
                    >
                      {t(`setup.day.${day}`)}
                    </Option>
                  ))}
                </fieldset>
              </>
            ) : (
              <ClockField
                label={t("setup.at")}
                value={draft.at}
                disabled={disabled}
                onChange={(at) => set({ at })}
                testId="setup-notify-at"
              />
            )}
          </div>
          <div className="grid w-full gap-1 text-left sm:w-80">
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
          <div className="w-full sm:w-80">
            <SwitchField
              label={t("setup.critical")}
              help={t("setup.criticalHelp")}
              checked={draft.critical}
              disabled={disabled}
              onChange={(critical) => set({ critical })}
              testId="setup-notify-critical"
            />
          </div>
          <div className={row}>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => finish({ ...draft, timezone: zone })}
              data-testid="setup-notify-apply"
            >
              {t("setup.apply")}
            </Button>
            {problem}
          </div>
        </div>
      )}
    </div>
  );
}
