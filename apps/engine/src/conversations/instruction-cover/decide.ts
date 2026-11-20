import {
  type ActionHints,
  type BoundAction,
  describeBoundAction,
  isNeverCovered,
} from "./bound-action.ts";
import { checkContent, collectContent } from "./content.ts";
import { buildEvidence, type GroundingReason, groundArguments } from "./grounding.ts";
import { checkQuote, normalizeForQuote } from "./normalize.ts";
import { instructionWords, ownWords, requestWords } from "./own-words.ts";
import { checkRequest } from "./request.ts";
import { namesAddressee, spokenFacts } from "./spoken.ts";

export const INSTRUCTION_WINDOW = 3;

export interface UserSegment {
  readonly id: string | null;
  readonly kind: "message" | "answer";
  readonly text: string;
}

export type CoverRefusal =
  | "tool_not_coverable"
  | "effect_class_never"
  | "effect_unknown"
  | "no_user_message"
  | "no_quote"
  | "quote_too_short"
  | "quote_too_long"
  | "quote_not_in_user_words"
  | "quote_in_pasted_text"
  | "content_not_given"
  | "not_a_request"
  | "conditional_or_negated"
  | "verb_mismatch"
  | "already_used"
  | GroundingReason;

export interface Because {
  readonly quote: string;
  readonly message_id: string | null;
}

export type CoverDecision =
  | {
      readonly covered: true;
      readonly because: Because;
      readonly action: BoundAction;
      readonly signature: string;
    }
  | {
      readonly covered: false;
      readonly reason: CoverRefusal;
      readonly detail?: string;
      readonly action: BoundAction;
    };

export interface CoverInput {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly quote: string | null;
  readonly segments: readonly UserSegment[];
  readonly outputs?: readonly unknown[];
  readonly shown?: readonly string[];
  readonly hints?: ActionHints;
  readonly used_signatures?: ReadonlySet<string>;
  readonly now: Date;
  readonly timezone: string;
}

export function actionSignature(action: BoundAction): string {
  return [action.tool, action.account ?? "", action.target ?? "", ...action.recipients].join("|");
}

function refuse(
  action: BoundAction,
  reason: CoverRefusal,
  detail?: string,
): Extract<CoverDecision, { covered: false }> {
  return { covered: false, reason, action, ...(detail ? { detail } : {}) };
}

function instructionWindow(segments: readonly UserSegment[]): UserSegment[] {
  let seen = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.kind !== "message") continue;
    seen += 1;
    if (seen === INSTRUCTION_WINDOW) return segments.slice(i);
  }
  return [...segments];
}

const WHOLE_EMAIL = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;

export function decideInstructionCover(input: CoverInput): CoverDecision {
  const hints = input.hints ?? {};
  const outputs = input.outputs ?? [];
  const preliminary = describeBoundAction(input.tool, input.args, [], hints);
  if (preliminary.verbs.length === 0 && preliminary.effect_class === "unknown") {
    return refuse(preliminary, "tool_not_coverable");
  }
  if (preliminary.effect_class === "unknown") {
    return refuse(preliminary, "effect_unknown", preliminary.target ?? undefined);
  }
  if (isNeverCovered(preliminary)) {
    return refuse(preliminary, "effect_class_never", preliminary.effect_class);
  }
  const raw = instructionWindow(input.segments);
  const window = raw.map((segment) =>
    segment.kind === "message" ? { ...segment, text: ownWords(segment.text) } : segment,
  );
  const latestIndex = window.findLastIndex((segment) => segment.kind === "message");
  const latest = window[latestIndex];
  if (!latest) return refuse(preliminary, "no_user_message");
  const facts = spokenFacts(
    window.map((segment) => segment.text),
    input.now,
    input.timezone,
  );
  const evidence = buildEvidence(outputs, facts);
  const instructed = raw.map((segment) =>
    segment.kind === "message" ? instructionWords(segment.text) : segment.text,
  );
  let addressees = spokenFacts(instructed, input.now, input.timezone);
  let recipient_evidence = evidence;
  for (let i = instructed.length - 1; i >= 0; i--) {
    const own = spokenFacts([instructed[i] ?? ""], input.now, input.timezone);
    if (!namesAddressee(own)) continue;
    addressees = own;
    const later = spokenFacts(instructed.slice(i + 1), input.now, input.timezone);
    const lookedUpLater = buildEvidence(outputs, later);
    if ([...lookedUpLater.named].some((value) => WHOLE_EMAIL.test(value))) {
      addressees = later;
      recipient_evidence = lookedUpLater;
    }
    break;
  }
  const grounded = groundArguments(input.tool, input.args, {
    window: facts,
    addressees,
    evidence,
    recipient_evidence,
    now: input.now,
    timezone: input.timezone,
  });
  const action = describeBoundAction(input.tool, input.args, grounded.recipients, hints);
  const quote = input.quote?.trim() ?? "";
  if (quote.length === 0) return refuse(action, "no_quote");
  const requested =
    latest.kind === "message" ? requestWords(raw[latestIndex]?.text ?? "") : latest.text;
  const checked = checkQuote(quote, requested);
  if (!checked.ok) {
    const pasted =
      checked.reason === "quote_not_in_user_words" &&
      checkQuote(quote, raw[latestIndex]?.text ?? "").ok;
    return refuse(action, pasted ? "quote_in_pasted_text" : checked.reason);
  }
  const request = checkRequest(normalizeForQuote(requested), checked.normalized, action.verbs, {
    draft: action.draft,
  });
  if (!request.ok) return refuse(action, request.reason, request.detail);
  if (grounded.failure) return refuse(action, grounded.failure.reason, grounded.failure.detail);
  if (!action.draft) {
    const content = checkContent(collectContent(input.tool, input.args), facts, input.shown ?? []);
    if (!content.ok) return refuse(action, "content_not_given", content.detail);
  }
  const signature = actionSignature(action);
  if (input.used_signatures?.has(signature)) return refuse(action, "already_used");
  return {
    covered: true,
    because: { quote, message_id: latest.id },
    action,
    signature,
  };
}
