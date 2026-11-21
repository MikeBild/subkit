import type { ApprovalRule } from "@/api/approval-rules";
import type { Translate, TranslationKey } from "@/lib/i18n";

export const RULE_LIFETIME_DAYS = 90;

export function splitRules(rules: readonly ApprovalRule[]): {
  active: ApprovalRule[];
  offered: ApprovalRule[];
} {
  const newestFirst = (a: ApprovalRule, b: ApprovalRule) =>
    ruleDates(b).created.localeCompare(ruleDates(a).created);
  return {
    active: rules.filter((rule) => rule.state === "active").sort(newestFirst),
    offered: rules.filter((rule) => rule.state === "offered").sort(newestFirst),
  };
}

export function ruleDates(rule: ApprovalRule): { created: string; lastUsed: string | null } {
  return {
    created:
      rule.state === "active"
        ? (rule.decided_at ?? rule.created_at)
        : (rule.offered_at ?? rule.created_at),
    lastUsed: rule.last_used_at,
  };
}

const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function namedConnector<Rule extends Pick<ApprovalRule, "connector" | "account">>(
  rule: Rule,
  nameFor: (id: string) => string | null | undefined,
): Rule {
  const named = (value: string | null) =>
    value && IDENTIFIER.test(value) ? (nameFor(value) ?? null) : value;
  return { ...rule, connector: named(rule.connector), account: named(rule.account) };
}

export const CONTENT_CLASS_KEYS: Readonly<Record<ApprovalRule["content_class"], TranslationKey>> = {
  no_content: "rules.content.no_content",
  same_content: "rules.content.same_content",
  person_given: "rules.content.person_given",
};

export function contentClassLine(contentClass: string, t: Translate): string {
  return t(
    CONTENT_CLASS_KEYS[contentClass as ApprovalRule["content_class"]] ??
      "rules.content.person_given",
  );
}

export type RuleValidity = "offered" | "expired" | "until";

export function ruleValidity(
  rule: Pick<ApprovalRule, "state" | "expired" | "expires_at">,
): RuleValidity {
  if (rule.state !== "active") return "offered";
  return rule.expired || !rule.expires_at ? "expired" : "until";
}

export function validityLine(
  rule: Pick<ApprovalRule, "state" | "expired" | "expires_at">,
  t: Translate,
  date: (value: string) => string,
): string {
  const validity = ruleValidity(rule);
  if (validity === "offered") return t("rules.validity.offered", { days: RULE_LIFETIME_DAYS });
  if (validity === "expired")
    return rule.expires_at
      ? t("rules.validity.expiredSince", { date: date(rule.expires_at) })
      : t("rules.validity.expired");
  return t("rules.validity.until", { date: date(rule.expires_at ?? "") });
}

export function todayLine(
  rule: Pick<ApprovalRule, "state" | "daily_limit" | "uses_today">,
  t: Translate,
): string {
  return rule.state === "active"
    ? t("rules.today.used", { count: rule.uses_today, limit: rule.daily_limit })
    : t("rules.today.limit", { limit: rule.daily_limit });
}

export interface RuleFact {
  id: "connector" | "operation" | "recipients" | "content" | "validity" | "today";
  label: string;
  value: string;
  short: string;
}

const SHORT_CONTENT_KEYS: Readonly<Record<ApprovalRule["content_class"], TranslationKey>> = {
  no_content: "rules.contentShort.no_content",
  same_content: "rules.contentShort.same_content",
  person_given: "rules.contentShort.person_given",
};

export function validityShort(
  rule: Pick<ApprovalRule, "state" | "expired" | "expires_at">,
  t: Translate,
  date: (value: string) => string,
): string {
  const validity = ruleValidity(rule);
  if (validity === "offered") return t("rules.short.days", { days: RULE_LIFETIME_DAYS });
  if (validity === "expired") return t("rules.expired");
  return t("rules.short.until", { date: date(rule.expires_at ?? "") });
}

export function todayShort(
  rule: Pick<ApprovalRule, "state" | "daily_limit" | "uses_today">,
  t: Translate,
): string {
  return rule.state === "active"
    ? t("rules.short.today", { count: rule.uses_today, limit: rule.daily_limit })
    : t("rules.short.limit", { limit: rule.daily_limit });
}

export function contentShort(contentClass: string, t: Translate): string {
  return t(
    SHORT_CONTENT_KEYS[contentClass as ApprovalRule["content_class"]] ??
      "rules.contentShort.person_given",
  );
}
export function ruleFacts(
  rule: ApprovalRule,
  t: Translate,
  date: (value: string) => string,
): RuleFact[] {
  const recipients =
    rule.recipients.length > 0 ? rule.recipients.join(", ") : t("rules.scope.noRecipient");
  return [
    ...(rule.connector
      ? [
          {
            id: "connector" as const,
            label: t("rules.field.connector"),
            value: rule.connector,
            short: rule.connector,
          },
        ]
      : []),
    ...(rule.operation && rule.operation !== rule.target
      ? [
          {
            id: "operation" as const,
            label: t("rules.field.operation"),
            value: rule.operation,
            short: rule.operation,
          },
        ]
      : []),
    {
      id: "recipients" as const,
      label: t("chat.policy.field.recipients"),
      value: recipients,
      short: recipients,
    },
    {
      id: "content" as const,
      label: t("chat.policy.field.content"),
      value: contentClassLine(rule.content_class, t),
      short: contentShort(rule.content_class, t),
    },
    {
      id: "validity" as const,
      label: t("rules.field.validity"),
      value: validityLine(rule, t, date),
      short: validityShort(rule, t, date),
    },
    {
      id: "today" as const,
      label: t("rules.field.today"),
      value: todayLine(rule, t),
      short: todayShort(rule, t),
    },
  ];
}
