import type { ExecutionAuthSource, ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolApprovalContentClass } from "../../db/schema/index.ts";
import { scopeOf } from "../approval-rules/core/rule-scope.ts";
import {
  contentHash,
  ruleExpiry,
  ruleRefusal,
  scopeCovers,
  usageDay,
} from "../approval-rules/scope.ts";
import { describeBoundAction } from "./bound-action.ts";
import { checkContent, collectContent } from "./content.ts";
import { type CoverDecision, decideInstructionCover, type UserSegment } from "./decide.ts";
import { groundArguments, NO_EVIDENCE } from "./grounding.ts";
import { ownWords } from "./own-words.ts";
import { interactivePersonRefusal } from "./session.ts";
import { spokenFacts } from "./spoken.ts";

export interface EvalSession {
  readonly auth:
    | "browser_session"
    | "api_key"
    | "mcp_oauth"
    | "token_exchange"
    | "external_bearer"
    | "task_run"
    | "cli_session"
    | "none";
  readonly surface?: string;
  readonly task_run?: boolean;
}

export interface EvalRule {
  readonly content_class: ToolApprovalContentClass;
  readonly approved_args?: Record<string, unknown>;
  readonly expires_in_days?: number;
  readonly daily_limit?: number;
  readonly uses_today?: number;
}

export interface CoverEvalCase {
  readonly id: string;
  readonly lang: "de" | "en";
  readonly expect: "run" | "ask";
  readonly messages: readonly string[];
  readonly answers?: readonly string[];
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly quote: string | null;
  readonly evidence?: readonly unknown[];
  readonly shown?: readonly string[];
  readonly template?: string;
  readonly session?: EvalSession;
  readonly rule?: EvalRule;
  readonly used?: readonly string[];
}

export interface CoverEvalInput {
  readonly now: string;
  readonly timezone: string;
  readonly cases: readonly CoverEvalCase[];
}

export type CoverEvalFailure = "needless_ask" | "ran_without_asking";

export interface CoverEvalOutcome {
  readonly id: string;
  readonly lang: "de" | "en";
  readonly expect: "run" | "ask";
  readonly got: "run" | "ask";
  readonly failure: CoverEvalFailure | null;
  readonly reason: string | null;
}

const AUTH_SOURCES: Readonly<Record<string, ExecutionAuthSource>> = {
  browser_session: { kind: "browser_session", session_id: "s" },
  cli_session: { kind: "browser_session", session_id: "s" },
  api_key: { kind: "api_key", api_key_id: "k", credential_version: "1" },
  mcp_oauth: { kind: "mcp_oauth", access_token_id: "t", client_id: "c" },
  token_exchange: {
    kind: "token_exchange",
    api_key_id: "k",
    credential_version: "1",
    expires_at: "2027-01-01T00:00:00Z",
  },
  external_bearer: {
    kind: "external_bearer",
    provider_id: "p",
    identity_id: "i",
    issued_at: "2026-01-01T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
  },
  task_run: { kind: "task_run", task_id: "t", task_run_id: "r", grant_id: null },
};

export function sessionRefusalOf(session: EvalSession | undefined): string | null {
  const auth = session?.auth ?? "browser_session";
  const source = AUTH_SOURCES[auth];
  const principal: Pick<
    ResolvedPrincipal,
    "kind" | "auth_source" | "credential_origin" | "api_key_id" | "via"
  > = {
    kind: "user",
    ...(source ? { auth_source: source } : {}),
    ...(auth === "cli_session" ? { credential_origin: "cli_oauth_session" as const } : {}),
    ...(auth === "api_key" ? { api_key_id: "k" } : {}),
  };
  return interactivePersonRefusal({
    principal,
    surface: session?.surface ?? "web",
    task_run: session?.task_run === true,
  });
}

function recipientsOf(tool: string, args: Record<string, unknown>): readonly string[] {
  const none = spokenFacts([], new Date(0), "UTC");
  return groundArguments(tool, args, {
    window: none,
    addressees: none,
    evidence: NO_EVIDENCE,
    now: new Date(0),
    timezone: "UTC",
  }).recipients;
}

export function ruleCoversEvalCase(input: CoverEvalInput, item: CoverEvalCase): boolean {
  const rule = item.rule;
  if (!rule) return false;
  const now = new Date(input.now);
  const hints = item.template ? { template: item.template } : {};
  const approvedArgs = rule.approved_args ?? item.args;
  const approved = describeBoundAction(
    item.tool,
    approvedArgs,
    recipientsOf(item.tool, approvedArgs),
    hints,
  );
  const action = describeBoundAction(
    item.tool,
    item.args,
    recipientsOf(item.tool, item.args),
    hints,
  );
  if (!scopeCovers(scopeOf(approved), action)) return false;
  const fields = collectContent(item.tool, item.args);
  const facts = spokenFacts(item.messages.map(ownWords), now, input.timezone);
  const expires = ruleExpiry(now).getTime() - (90 - (rule.expires_in_days ?? 90)) * 86_400_000;
  return (
    ruleRefusal(
      {
        content_class: rule.content_class,
        content_hash: contentHash(collectContent(item.tool, approvedArgs)),
        expires_at: new Date(expires),
        daily_limit: rule.daily_limit ?? 20,
        uses_day: usageDay(now),
        uses_on_day: rule.uses_today ?? 0,
      },
      {
        hash: contentHash(fields),
        given: fields.length > 0 && checkContent(fields, facts, item.shown ?? []).ok,
      },
      now,
    ) === null
  );
}

export function decideEvalCase(input: CoverEvalInput, item: CoverEvalCase): CoverDecision {
  const now = new Date(input.now);
  const segments: UserSegment[] = [
    ...item.messages.map((text, index) => ({
      id: `message-${index}`,
      kind: "message" as const,
      text,
    })),
    ...(item.answers ?? []).map((text) => ({ id: null, kind: "answer" as const, text })),
  ];
  return decideInstructionCover({
    tool: item.tool,
    args: item.args,
    quote: item.quote,
    segments,
    outputs: item.evidence ?? [],
    shown: item.shown ?? [],
    ...(item.template ? { hints: { template: item.template } } : {}),
    used_signatures: new Set(item.used ?? []),
    now,
    timezone: input.timezone,
  });
}

export function gradeEvalCase(input: CoverEvalInput, item: CoverEvalCase): CoverEvalOutcome {
  const session = sessionRefusalOf(item.session);
  const byRule = session === null && ruleCoversEvalCase(input, item);
  const decision = decideEvalCase(input, item);
  const got = session === null && (byRule || decision.covered) ? "run" : "ask";
  const failure: CoverEvalFailure | null =
    got === item.expect ? null : got === "ask" ? "needless_ask" : "ran_without_asking";
  return {
    id: item.id,
    lang: item.lang,
    expect: item.expect,
    got,
    failure,
    reason:
      session !== null
        ? session
        : byRule || decision.covered
          ? null
          : `${decision.reason}${decision.detail ? `: ${decision.detail}` : ""}`,
  };
}
