import type { Setup, SetupChatMode, SetupEnvironment, SetupUpdate } from "@/api/setup";
import type { TranslationKey } from "@/lib/i18n";
import { timeZoneLabel } from "@/lib/timezones";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const SETUP_QUESTIONS = [
  "job",
  "services",
  "approver",
  "chatMode",
  "env",
  "notify",
] as const;
export type SetupQuestionId = (typeof SETUP_QUESTIONS)[number];

export const SETUP_JOBS = [
  "invoices",
  "dailyNumbers",
  "weekSummary",
  "tickets",
  "prices",
  "payment",
] as const;
export type SetupJob = (typeof SETUP_JOBS)[number];

export const OTHER = "other";

export const SETUP_SERVICES = [
  "gmail",
  "google-drive",
  "google-sheets",
  "slack",
  "jira",
  "github",
  "notion",
  "hubspot",
  "stripe",
] as const;
export type SetupService = (typeof SETUP_SERVICES)[number];

export const SERVICE_NAMES: Readonly<Record<SetupService, string>> = {
  gmail: "Gmail",
  "google-drive": "Google Drive",
  "google-sheets": "Google Sheets",
  slack: "Slack",
  jira: "Jira",
  github: "GitHub",
  notion: "Notion",
  hubspot: "HubSpot",
  stripe: "Stripe",
};

export const JOB_SERVICES: Readonly<Record<SetupJob, readonly SetupService[]>> = {
  invoices: ["gmail", "google-drive"],
  dailyNumbers: ["google-sheets", "gmail"],
  weekSummary: ["slack", "notion"],
  tickets: ["jira", "github"],
  prices: ["slack"],
  payment: ["stripe", "hubspot"],
};

export const JOB_MARK: Readonly<Record<SetupJob, SetupService | null>> = {
  invoices: "gmail",
  dailyNumbers: "google-sheets",
  weekSummary: "slack",
  tickets: "jira",
  prices: null,
  payment: "stripe",
};

export const SETUP_MODES: readonly SetupChatMode[] = ["ask", "auto", "plan"];
export const SETUP_ENVIRONMENTS: readonly SetupEnvironment[] = ["dev", "prod"];
export const NOTIFY_MODES = ["immediately", "working_hours", "daily_digest"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

export const JOB_MAX = 120;

export interface SetupAnswers {
  job: SetupJob | typeof OTHER | null;
  jobOther: string;
  services: string[];
  approver: "self" | "teammate";
  approverEmail: string;
  chatMode: SetupChatMode;
  env: SetupEnvironment;
  notify: NotifyMode;
  from: string;
  to: string;
  at: string;
  days: number[];
  timezone: string | null;
  critical: boolean;
}

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

export function workingDays(days: readonly number[] | undefined): number[] {
  const chosen = WEEKDAYS.filter((day) => (days ?? DEFAULT_WORKING_DAYS).includes(day));
  return chosen;
}

export function toggleDay(days: readonly number[], day: number): number[] {
  return WEEKDAYS.filter((candidate) =>
    candidate === day ? !days.includes(day) : days.includes(candidate),
  );
}

export function daysLabel(days: readonly number[], t: Translate): string {
  const chosen = workingDays(days);
  const name = (day: number) => t(`setup.day.${day}` as TranslationKey);
  const first = chosen[0];
  const last = chosen[chosen.length - 1];
  if (first === undefined || last === undefined) return "";
  if (chosen.length === 7) return t("setup.days.all");
  const consecutive = last - first + 1 === chosen.length;
  return consecutive && chosen.length > 2
    ? `${name(first)}–${name(last)}`
    : chosen.map(name).join(", ");
}

const DEFAULT_FROM = "08:00";
const DEFAULT_TO = "18:00";
const DEFAULT_AT = "08:00";

export function isSetupJob(value: string | null | undefined): value is SetupJob {
  return (SETUP_JOBS as readonly string[]).includes(value ?? "");
}

function isSetupService(value: string): value is SetupService {
  return (SETUP_SERVICES as readonly string[]).includes(value);
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isClock(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

type Schedule = Setup["notifications"];

function scheduleAnswers(
  schedule: Schedule,
): Pick<SetupAnswers, "notify" | "from" | "to" | "at" | "days"> {
  return {
    notify: schedule.mode,
    days: workingDays(schedule.mode === "working_hours" ? schedule.days : undefined),
    from: schedule.mode === "working_hours" ? schedule.from : DEFAULT_FROM,
    to: schedule.mode === "working_hours" ? schedule.to : DEFAULT_TO,
    at: schedule.mode === "daily_digest" ? schedule.at : DEFAULT_AT,
  };
}

export function answersFromSetup(setup: Setup): SetupAnswers {
  const job = setup.first_job;
  return {
    job: job === null ? null : isSetupJob(job) ? job : OTHER,
    jobOther: job !== null && !isSetupJob(job) ? job : "",
    services: [...setup.services],
    approver: setup.approver.kind,
    approverEmail: setup.approver.kind === "teammate" ? setup.approver.email : "",
    chatMode: setup.default_chat_mode,
    env: setup.default_environment,
    ...scheduleAnswers(setup.notifications),
    timezone: setup.timezone,
    critical: setup.critical_breakthrough,
  };
}

function schedule(answers: SetupAnswers): Schedule {
  if (answers.notify === "working_hours")
    return {
      mode: "working_hours",
      from: answers.from,
      to: answers.to,
      days: workingDays(answers.days),
    };
  if (answers.notify === "daily_digest") return { mode: "daily_digest", at: answers.at };
  return { mode: "immediately" };
}

function firstJob(answers: SetupAnswers): string | null {
  if (answers.job === null) return null;
  if (answers.job !== OTHER) return answers.job;
  return answers.jobOther.trim().slice(0, JOB_MAX) || null;
}

export function questionUpdate(id: SetupQuestionId, answers: SetupAnswers): SetupUpdate {
  if (id === "job") return { first_job: firstJob(answers), services: answers.services };
  if (id === "services") return { services: answers.services };
  if (id === "approver")
    return {
      approver:
        answers.approver === "teammate"
          ? { kind: "teammate", email: answers.approverEmail.trim() }
          : { kind: "self" },
    };
  if (id === "chatMode") return { default_chat_mode: answers.chatMode };
  if (id === "env") return { default_environment: answers.env };
  return {
    notifications: schedule(answers),
    timezone: answers.timezone,
    critical_breakthrough: answers.critical,
  };
}

export function setupUpdate(answers: SetupAnswers): SetupUpdate {
  return Object.assign({}, ...SETUP_QUESTIONS.map((id) => questionUpdate(id, answers)));
}

export function recommendedUpdate(setup: Pick<Setup, "recommended">): SetupUpdate {
  return {
    default_chat_mode: setup.recommended.default_chat_mode,
    default_environment: setup.recommended.default_environment,
    approver: setup.recommended.approver,
    notifications: setup.recommended.notifications,
    critical_breakthrough: setup.recommended.critical_breakthrough,
  };
}

export function setupPending(setup: Pick<Setup, "unset"> | undefined): boolean {
  return (setup?.unset.length ?? 0) > 0;
}

export const SETUP_PERMISSION = "settings:write";

export function setupOffered(permissions: readonly string[]): boolean {
  return permissions.includes(SETUP_PERMISSION);
}

const SETUP_LATER_PREFIX = "sk-cockpit-setup-later";

type LaterStore = Pick<Storage, "getItem" | "setItem">;

function laterKey(person: { tenantId: string; userId: string }): string {
  return `${SETUP_LATER_PREFIX}:${person.tenantId}:${person.userId}`;
}

function browserStore(): LaterStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function setupPostponed(
  person: { tenantId: string; userId: string },
  store: LaterStore | null = browserStore(),
): boolean {
  try {
    return store?.getItem(laterKey(person)) === "1";
  } catch {
    return false;
  }
}

export function postponeSetup(
  person: { tenantId: string; userId: string },
  store: LaterStore | null = browserStore(),
): void {
  try {
    store?.setItem(laterKey(person), "1");
  } catch {
    return;
  }
}

export type SetupGateView = "checking" | "open" | "passed";

export function setupGateView(input: {
  permissions: readonly string[];
  postponed: boolean;
  setup: Pick<Setup, "unset"> | undefined;
  failed: boolean;
}): SetupGateView {
  if (!setupOffered(input.permissions) || input.postponed || input.failed) return "passed";
  if (!input.setup) return "checking";
  return setupPending(input.setup) ? "open" : "passed";
}

export function questionError(id: SetupQuestionId, answers: SetupAnswers): TranslationKey | null {
  if (id === "job" && answers.job === OTHER && !answers.jobOther.trim()) return "setup.otherError";
  if (id === "services" && answers.services.length === 0) return "setup.servicesError";
  if (id === "approver" && answers.approver === "teammate" && !isEmail(answers.approverEmail))
    return "setup.emailError";
  if (id === "notify") {
    if (answers.notify === "working_hours" && !(isClock(answers.from) && isClock(answers.to)))
      return "setup.timeError";
    if (answers.notify === "working_hours" && workingDays(answers.days).length === 0)
      return "setup.daysError";
    if (answers.notify === "daily_digest" && !isClock(answers.at)) return "setup.timeError";
  }
  return null;
}

export function serviceName(slug: string, t: Translate): string {
  return isSetupService(slug) ? SERVICE_NAMES[slug] : t("setup.service.other");
}

export function jobLabel(job: string | null, t: Translate): string | null {
  if (job === null) return null;
  return isSetupJob(job) ? t(`setup.job.${job}`) : job;
}

export function zoneLine(timezone: string | null, t: Translate): string {
  return timezone
    ? t("setup.zoneValue", { zone: timeZoneLabel(timezone) })
    : t("setup.zoneWorkspace");
}

function notifyValue(answers: SetupAnswers, t: Translate): string {
  if (answers.notify === "immediately") return t("setup.notify.immediately");
  return [
    answers.notify === "working_hours"
      ? t("setup.hoursValue", {
          days: daysLabel(answers.days, t),
          from: answers.from,
          to: answers.to,
        })
      : t("setup.dailyValue", { at: answers.at }),
    zoneLine(answers.timezone, t),
    t(answers.critical ? "setup.criticalValue.on" : "setup.criticalValue.off"),
  ].join(" · ");
}

export function setupValue(id: SetupQuestionId, answers: SetupAnswers, t: Translate): string {
  if (id === "job") return jobLabel(firstJob(answers), t) ?? t("setup.none");
  if (id === "services")
    return answers.services.length > 0
      ? answers.services.map((slug) => serviceName(slug, t)).join(" · ")
      : t("setup.none");
  if (id === "approver")
    return answers.approver === "teammate"
      ? t("setup.approverValue", {
          who: t("setup.approver.teammate"),
          email: answers.approverEmail.trim(),
        })
      : t("setup.approver.self");
  if (id === "chatMode") return t(`setup.mode.${answers.chatMode}`);
  if (id === "env") return t(`setup.env.${answers.env}`);
  return notifyValue(answers, t);
}

export function scheduleSentence(notifications: Schedule, t: Translate): string {
  if (notifications.mode === "working_hours")
    return t("setup.schedule.working_hours", {
      days: daysLabel(workingDays(notifications.days), t),
      from: notifications.from,
      to: notifications.to,
    });
  if (notifications.mode === "daily_digest")
    return t("setup.schedule.daily_digest", { at: notifications.at });
  return t("setup.schedule.immediately");
}

export function scheduleNote(
  setup: Pick<Setup, "notifications" | "timezone" | "critical_breakthrough">,
  t: Translate,
): { line: string; detail: string } {
  const scheduled = setup.notifications.mode !== "immediately";
  return {
    line: t("setup.schedule.title", { schedule: scheduleSentence(setup.notifications, t) }),
    detail: [
      ...(scheduled
        ? [
            `${zoneLine(setup.timezone, t)}.`,
            t(
              setup.critical_breakthrough
                ? "setup.schedule.critical.on"
                : "setup.schedule.critical.off",
            ),
          ]
        : []),
      t("setup.schedule.scope"),
      t("setup.schedule.expiry"),
    ].join(" "),
  };
}

export function firstServiceNames(services: readonly string[]): string[] {
  return services.filter(isSetupService).map((slug) => SERVICE_NAMES[slug]);
}

export function firstJobPrompt(
  setup: Pick<Setup, "first_job" | "services">,
  t: Translate,
): string | null {
  const job = jobLabel(setup.first_job, t);
  if (!job) return null;
  const services = firstServiceNames(setup.services);
  return services.length > 0
    ? t("setup.firstJobPromptServices", { job, services: services.join(", ") })
    : t("setup.firstJobPrompt", { job });
}

interface PersonalStep {
  id: string;
  title: string;
  line: string;
  href: string;
  done: boolean;
}

export function personalStartSteps<Step extends PersonalStep>(
  steps: readonly Step[],
  setup: Pick<Setup, "first_job" | "services"> | undefined,
  t: Translate,
  jobHref: (prompt: string) => string | null,
): PersonalStep[] {
  if (!setup) return [...steps];
  const names = firstServiceNames(setup.services);
  const ordered: PersonalStep[] = steps.map((step) =>
    step.id === "connector" && names.length > 0
      ? { ...step, line: `${t("setup.connectFirst", { names: names.join(" · ") })}. ${step.line}` }
      : step,
  );
  const job = jobLabel(setup.first_job, t);
  const prompt = firstJobPrompt(setup, t);
  const href = prompt ? jobHref(prompt) : null;
  if (!job || !href) return ordered;
  return [
    {
      id: "first-job",
      title: t("setup.firstJob", { job }),
      line: t("setup.firstJobHelp"),
      href,
      done: steps.find((step) => step.id === "workflow")?.done ?? false,
    },
    ...ordered,
  ];
}

interface Starter {
  id: string;
  icon: "create";
  title: string;
  line: string;
  prompt: string;
}

export function firstJobStarter(
  setup: Pick<Setup, "first_job" | "services"> | undefined,
  t: Translate,
): Starter | null {
  if (!setup) return null;
  const job = jobLabel(setup.first_job, t);
  const prompt = firstJobPrompt(setup, t);
  if (!job || !prompt) return null;
  return { id: "first-job", icon: "create", title: job, line: t("setup.firstJobHelp"), prompt };
}
