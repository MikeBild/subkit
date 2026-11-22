import type { components } from "@cli-core/engine-api/openapi";
import type { PluralKey, Translate, TranslationKey } from "@/lib/i18n";

type TranslatePlural = (
  key: PluralKey,
  count: number,
  values?: Record<string, string | number>,
) => string;

export type ToolCallPolicy = NonNullable<components["schemas"]["ConversationToolCall"]["policy"]>;
export type BoundAction = components["schemas"]["BoundAction"];
export type RuleOffer = NonNullable<components["schemas"]["ToolApprovalRuleOffer"]>;

export interface ActionScope {
  verb: string;
  target: string | null;
  account: string | null;
  recipients: readonly string[];
}

const VERBS = ["send", "create", "update", "run", "save", "other"] as const;
type Verb = (typeof VERBS)[number];

const NAMED_EFFECTS = [
  "payment",
  "deletion",
  "publication",
  "permission_or_settings",
  "account_creation",
  "credential",
] as const;
type NamedEffect = (typeof NAMED_EFFECTS)[number];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function boundActionOf(value: unknown): BoundAction | null {
  const source = record(value);
  if (!source || typeof source.verb !== "string") return null;
  return {
    verb: (VERBS as readonly string[]).includes(source.verb) ? (source.verb as Verb) : "other",
    effect_class: (typeof source.effect_class === "string"
      ? source.effect_class
      : "unknown") as BoundAction["effect_class"],
    target: text(source.target),
    account: text(source.account),
    recipients: Array.isArray(source.recipients)
      ? source.recipients.filter((entry): entry is string => typeof entry === "string")
      : [],
    content_summary: text(source.content_summary),
    ...(text(source.content) ? { content: text(source.content) } : {}),
  };
}

export const FULL_CONTENT_CAP = 8000;

export interface FullContent {
  text: string;
  capped: boolean;
  long: boolean;
}

const LONG_CONTENT_CHARS = 600;
const LONG_CONTENT_LINES = 10;

export function fullContent(action: Pick<BoundAction, "content">): FullContent | null {
  const content = action.content;
  if (typeof content !== "string" || !content.trim()) return null;
  return {
    text: content,
    capped: content.length >= FULL_CONTENT_CAP && content.endsWith("…"),
    long: content.length > LONG_CONTENT_CHARS || content.split("\n").length > LONG_CONTENT_LINES,
  };
}

export interface ApprovalBinding {
  action: BoundAction;
  askReason: string | null;
  askDetail: string | null;
  because: string | null;
}

export function approvalBinding(call: {
  input?: unknown;
  policy?: ToolCallPolicy | null;
}): ApprovalBinding | null {
  const input = record(call.input);
  const action = boundActionOf(call.policy?.bound_action) ?? boundActionOf(input?.bound_action);
  if (!action) return null;
  return {
    action,
    askReason: call.policy?.ask_reason ?? text(input?.ask_reason),
    askDetail: text(call.policy?.ask_detail) ?? text(input?.ask_detail),
    because: call.policy?.because?.quote ?? null,
  };
}

const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function namedAccount<Scope extends { account: string | null }>(
  scope: Scope,
  nameFor: (id: string) => string | null | undefined,
): Scope {
  if (!scope.account || !IDENTIFIER.test(scope.account)) return scope;
  return { ...scope, account: nameFor(scope.account) ?? null };
}

export function verbLabel(verb: string, t: Translate): string {
  return t(
    `chat.policy.verb.${(VERBS as readonly string[]).includes(verb) ? (verb as Verb) : "other"}`,
  );
}

export function effectLabel(effect: string, t: Translate): string | null {
  return (NAMED_EFFECTS as readonly string[]).includes(effect)
    ? t(`chat.policy.effect.${effect as NamedEffect}`)
    : null;
}

const REQUEST_TARGET =
  /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(?:https?:\/\/[^/\s]+)?(\/\S*)$/i;
const VERSION_SEGMENT = /^v\d+(?:\.\d+)*$/i;
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,}|\{[^}]*\}|:\w+)$/i;
const ACTION_SEGMENTS = new Set([
  "send",
  "create",
  "update",
  "delete",
  "remove",
  "run",
  "execute",
  "search",
  "list",
  "get",
  "post",
  "batch",
  "import",
  "export",
]);

export function rawRequest(target: string | null): string | null {
  return target && REQUEST_TARGET.test(target.trim()) ? target.trim() : null;
}

export function targetLabel(target: string | null): string | null {
  if (!target?.trim()) return null;
  const path = REQUEST_TARGET.exec(target.trim())?.[1];
  if (path === undefined) return target;
  const segments = path
    .split(/[?#]/)[0]
    ?.split("/")
    .map((segment) => decodeSegment(segment))
    .filter((segment) => segment && !VERSION_SEGMENT.test(segment) && !ID_SEGMENT.test(segment));
  if (!segments?.length) return null;
  const resource =
    segments.length > 1 && ACTION_SEGMENTS.has((segments.at(-1) ?? "").toLowerCase())
      ? segments.at(-2)
      : segments.at(-1);
  if (!resource) return null;
  const words = resource.replace(/[-_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function actionLine(action: ActionScope, t: Translate): string {
  const verb = verbLabel(action.verb, t);
  const recipients = action.recipients.join(", ");
  const target = targetLabel(action.target);
  if (target && recipients) return t("chat.policy.actionTargetTo", { verb, target, recipients });
  if (recipients) return t("chat.policy.actionTo", { verb, recipients });
  if (target) return t("chat.policy.action", { verb, target });
  return verb;
}

export interface PolicyFact {
  id: "verb" | "target" | "account" | "content";
  label: string;
  value: string;
}

export function actionFacts(
  action: ActionScope & {
    effect_class?: string;
    content_summary?: string | null;
    content?: string | null;
  },
  t: Translate,
  tn: TranslatePlural,
): PolicyFact[] {
  const effect = action.effect_class ? effectLabel(action.effect_class, t) : null;
  const verb = verbLabel(action.verb, t);
  const recipients = action.recipients.join(", ");
  const target =
    action.recipients.length > 1
      ? tn("chat.policy.recipientCount", action.recipients.length, { recipients })
      : recipients || targetLabel(action.target);
  return [
    {
      id: "verb" as const,
      label: t("chat.policy.field.verb"),
      value: effect ? `${verb} · ${effect}` : verb,
    },
    ...(target
      ? [{ id: "target" as const, label: t("chat.policy.field.target"), value: target }]
      : []),
    ...(action.account
      ? [{ id: "account" as const, label: t("chat.policy.field.account"), value: action.account }]
      : []),
    ...(action.content_summary && !fullContent(action)
      ? [
          {
            id: "content" as const,
            label: t("chat.policy.field.content"),
            value: action.content_summary,
          },
        ]
      : []),
  ];
}

export const ASK_REASON_KEYS: Readonly<Record<string, TranslationKey>> = {
  ask_before_writing: "chat.policy.ask.askFirst",
  no_person: "chat.policy.ask.session",
  write_gate: "chat.policy.ask.notRequested",
  tool_not_coverable: "chat.policy.ask.kind",
  effect_class_never: "chat.policy.ask.always",
  no_user_message: "chat.policy.ask.notRequested",
  no_quote: "chat.policy.ask.notRequested",
  quote_too_short: "chat.policy.ask.notRequested",
  quote_too_long: "chat.policy.ask.notRequested",
  quote_not_in_user_words: "chat.policy.ask.notRequested",
  not_a_request: "chat.policy.ask.notRequested",
  verb_mismatch: "chat.policy.ask.notRequested",
  conditional_or_negated: "chat.policy.ask.conditional",
  already_used: "chat.policy.ask.used",
  recipient_not_named: "chat.policy.ask.recipient",
  target_not_named: "chat.policy.ask.target",
  value_not_said: "chat.policy.ask.value",
  date_not_said: "chat.policy.ask.date",
  undecidable: "chat.policy.ask.unclear",
  effect_unknown: "chat.policy.ask.unknownEffect",
  quote_in_pasted_text: "chat.policy.ask.pasted",
  content_not_given: "chat.policy.ask.content",
  header_not_requested: "chat.policy.ask.header",
  no_browser_session: "chat.policy.ask.session",
  rule_expired: "chat.policy.ask.ruleExpired",
  rule_daily_limit: "chat.policy.ask.ruleLimit",
  rule_content: "chat.policy.ask.ruleContent",
  always_ask: "chat.policy.ask.always",
  job_expired: "chat.policy.ask.notRequested",
  commit_not_requested: "chat.policy.ask.notRequested",
  value_not_given: "chat.policy.ask.content",
  not_started_by_person: "chat.policy.ask.session",
};

export function askReasonKey(reason: string | null): TranslationKey | null {
  if (!reason) return null;
  return ASK_REASON_KEYS[reason] ?? "chat.policy.ask.unclear";
}

export interface RanWithoutAsking {
  quote: string | null;
  rule: "user_instruction" | "standing_rule";
  action: BoundAction;
}

export function ranWithoutAsking(
  policy: ToolCallPolicy | null | undefined,
): RanWithoutAsking | null {
  if (!policy?.ran_without_asking || !policy.rule) return null;
  const action = boundActionOf(policy.bound_action);
  if (!action) return null;
  return { quote: policy.because?.quote ?? null, rule: policy.rule, action };
}

export function ranLine(ran: RanWithoutAsking, t: Translate): string {
  return t("chat.policy.ran", {
    action: actionLine(ran.action, t),
    why: t(ran.rule === "standing_rule" ? "chat.policy.becauseRule" : "chat.policy.becauseAsked"),
  });
}

export function ruleName(scope: ActionScope, t: Translate): string {
  const verb = verbLabel(scope.verb, t);
  const target = targetLabel(scope.target);
  return target ? t("rules.name", { verb, target }) : t("rules.nameBare", { verb });
}

export function scopeSentence(scope: ActionScope, t: Translate): string {
  return [
    ruleName(scope, t),
    scope.account ? t("rules.scope.via", { account: scope.account }) : null,
    scope.recipients.length > 0
      ? t("rules.scope.to", { recipients: scope.recipients.join(", ") })
      : t("rules.scope.noRecipient"),
  ]
    .filter(Boolean)
    .join(" ");
}

export const LIVE_POLICY_KEY = "tool-call-policy";

export function livePolicy(event: {
  type: string;
  [key: string]: unknown;
}): { callId: string; policy: ToolCallPolicy } | null {
  if (event.type !== "data_part" || event.data_type !== "ran_without_asking") return null;
  const payload = record(event.payload);
  const policy = record(payload?.policy);
  if (!payload || !policy || typeof payload.call_id !== "string") return null;
  return { callId: payload.call_id, policy: policy as ToolCallPolicy };
}
