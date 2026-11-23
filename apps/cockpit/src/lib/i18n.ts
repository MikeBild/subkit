import { accessDe, accessEn } from "./i18n/access";
import { appsDe, appsEn } from "./i18n/apps";
import { auditDe, auditEn } from "./i18n/audit";
import { authorityDe, authorityEn } from "./i18n/authority";
import { authorityBoundariesDe, authorityBoundariesEn } from "./i18n/authority-boundaries";
import { authorityProposalsDe, authorityProposalsEn } from "./i18n/authority-proposals";
import { automationDe, automationEn } from "./i18n/automation";
import { brandingDe, brandingEn } from "./i18n/branding";
import { catalogDe, catalogEn } from "./i18n/catalog";
import { chatDe, chatEn } from "./i18n/chat";
import { connectorDe, connectorEn } from "./i18n/connector";
import { createDe, createEn } from "./i18n/create";
import { decisionsDe, decisionsEn } from "./i18n/decisions";
import { diagnosisDe, diagnosisEn } from "./i18n/diagnosis";
import { engineSentenceDe, engineSentenceEn } from "./i18n/engine-sentence";
import { feedbackDe, feedbackEn } from "./i18n/feedback";
import { intakeDe, intakeEn } from "./i18n/intake";
import { knDe, knEn } from "./i18n/kn";
import { knowledgeDe, knowledgeEn } from "./i18n/knowledge";
import { notificationsDe, notificationsEn } from "./i18n/notifications";
import { onboardingDe, onboardingEn } from "./i18n/onboarding";
import { operationsDe, operationsEn } from "./i18n/operations";
import { operationsScreensDe, operationsScreensEn } from "./i18n/operations-screens";
import { overviewDe, overviewEn } from "./i18n/overview";
import { pwaDe, pwaEn } from "./i18n/pwa";
import { resourceDe, resourceEn } from "./i18n/resource";
import { runsDe, runsEn } from "./i18n/runs";
import { settingsDe, settingsEn } from "./i18n/settings";
import { settingsAiDe, settingsAiEn } from "./i18n/settings-ai";
import { settingsHelpDe, settingsHelpEn } from "./i18n/settings-help";
import { settingsLeafDe, settingsLeafEn } from "./i18n/settings-leaf";
import { settingsPackagesDe, settingsPackagesEn } from "./i18n/settings-packages";
import { settingsPersonalDe, settingsPersonalEn } from "./i18n/settings-personal";
import { setupDe, setupEn } from "./i18n/setup";
import { shellDe, shellEn } from "./i18n/shell";
import { skillsDe, skillsEn } from "./i18n/skills";
import { taskGrantDe, taskGrantEn } from "./i18n/task-grant";
import { taskRunDe, taskRunEn } from "./i18n/task-run";
import { tasksDe, tasksEn } from "./i18n/tasks";
import { toolDe, toolEn } from "./i18n/tool";
import { usageDe, usageEn } from "./i18n/usage";
import { vaultDe, vaultEn } from "./i18n/vault";
import { workflowDe, workflowEn } from "./i18n/workflow";
import { workflowReviewDe, workflowReviewEn } from "./i18n/workflow-review";

export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  de: "de-DE",
};

const EN = {
  ...accessEn,
  ...appsEn,
  ...auditEn,
  ...authorityEn,
  ...authorityBoundariesEn,
  ...authorityProposalsEn,
  ...automationEn,
  ...brandingEn,
  ...catalogEn,
  ...chatEn,
  ...connectorEn,
  ...createEn,
  ...decisionsEn,
  ...diagnosisEn,
  ...feedbackEn,
  ...engineSentenceEn,
  ...intakeEn,
  ...knEn,
  ...knowledgeEn,
  ...notificationsEn,
  ...onboardingEn,
  ...operationsEn,
  ...operationsScreensEn,
  ...overviewEn,
  ...pwaEn,
  ...resourceEn,
  ...runsEn,
  ...settingsEn,
  ...settingsAiEn,
  ...settingsHelpEn,
  ...settingsLeafEn,
  ...settingsPackagesEn,
  ...settingsPersonalEn,
  ...setupEn,
  ...shellEn,
  ...skillsEn,
  ...taskGrantEn,
  ...tasksEn,
  ...taskRunEn,
  ...toolEn,
  ...usageEn,
  ...vaultEn,
  ...workflowEn,
  ...workflowReviewEn,
} as const;

export type TranslationKey = keyof typeof EN;

export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const DE: Record<TranslationKey, string> = {
  ...accessDe,
  ...appsDe,
  ...auditDe,
  ...authorityDe,
  ...authorityBoundariesDe,
  ...authorityProposalsDe,
  ...automationDe,
  ...brandingDe,
  ...catalogDe,
  ...chatDe,
  ...connectorDe,
  ...createDe,
  ...decisionsDe,
  ...diagnosisDe,
  ...feedbackDe,
  ...engineSentenceDe,
  ...intakeDe,
  ...knDe,
  ...knowledgeDe,
  ...notificationsDe,
  ...onboardingDe,
  ...operationsDe,
  ...operationsScreensDe,
  ...overviewDe,
  ...pwaDe,
  ...resourceDe,
  ...runsDe,
  ...settingsDe,
  ...settingsAiDe,
  ...settingsHelpDe,
  ...settingsLeafDe,
  ...settingsPackagesDe,
  ...settingsPersonalDe,
  ...setupDe,
  ...shellDe,
  ...skillsDe,
  ...taskGrantDe,
  ...tasksDe,
  ...taskRunDe,
  ...toolDe,
  ...usageDe,
  ...vaultDe,
  ...workflowDe,
  ...workflowReviewDe,
};

export const CATALOGS: Record<Locale, Record<TranslationKey, string>> = {
  en: EN,
  de: DE,
};

export function interpolate(
  template: string,
  values: Record<string, string | number> = {},
): string {
  return template.replace(/\{([^}]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  values?: Record<string, string | number>,
): string {
  return interpolate(CATALOGS[locale][key], values);
}

export type PluralKey = {
  [K in TranslationKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends TranslationKey
      ? Base
      : never
    : never;
}[TranslationKey];

export function pluralKey(key: PluralKey, count: number): TranslationKey {
  return `${key}.${count === 1 ? "one" : "other"}` as TranslationKey;
}

export function translatePlural(
  locale: Locale,
  key: PluralKey,
  count: number,
  values: Record<string, string | number> = {},
): string {
  const number = new Intl.NumberFormat(LOCALE_TAGS[locale]);
  const formatted = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      typeof value === "number" ? number.format(value) : value,
    ]),
  );
  return translate(locale, pluralKey(key, count), {
    ...formatted,
    count: number.format(count),
  });
}

export function formatDateTime(locale: Locale, value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatMoney(locale: Locale, amount: number, currency: string): string {
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(LOCALE_TAGS[locale], {
      style: "currency",
      currency,
      ...digits,
    }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(LOCALE_TAGS[locale], digits).format(amount)} ${currency}`;
  }
}

export function formatDate(locale: Locale, value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: "medium" }).format(date);
}

export function formatShortRelativeTime(
  locale: Locale,
  value: string,
  nowLabel: string,
  now = Date.now(),
): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return "";
  const abs = Math.abs(Math.round((at - now) / 1000));
  const unit = (amount: number, name: Intl.NumberFormatOptions["unit"]): string =>
    new Intl.NumberFormat(LOCALE_TAGS[locale], {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(amount);
  if (abs < 60) return nowLabel;
  if (abs < 3600) return unit(Math.round(abs / 60), "minute");
  if (abs < 86_400) return unit(Math.round(abs / 3600), "hour");
  if (abs < 7 * 86_400) return unit(Math.round(abs / 86_400), "day");
  if (abs < 31 * 86_400) return unit(Math.round(abs / (7 * 86_400)), "week");
  if (abs < 365 * 86_400) return unit(Math.round(abs / (30 * 86_400)), "month");
  return unit(Math.round(abs / (365 * 86_400)), "year");
}

export function formatRelativeTime(locale: Locale, value: string, now = Date.now()): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return "";
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(LOCALE_TAGS[locale], {
    numeric: "auto",
    style: "short",
  });
  if (abs < 60)
    return rtf.format(0, "second").replace(/^in 0 s$|^jetzt$/i, locale === "de" ? "jetzt" : "now");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
  if (abs < 31 * 86_400) return rtf.format(Math.round(seconds / (7 * 86_400)), "week");
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: "medium" }).format(new Date(at));
}
