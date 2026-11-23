import { findSecretSpans } from "@shared/redaction.ts";
import { checkQuote, normalizeForQuote } from "../../conversations/instruction-cover/normalize.ts";
import { ownWords } from "../../conversations/instruction-cover/own-words.ts";

export const MAX_ACTIVE_NOTES = 300;
export const MAX_NOTE_TEXT_CHARS = 600;
export const MAX_NOTE_ABSTRACT_CHARS = 160;
export const NOTE_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const NOTE_AREAS = ["about", "preferences", "people", "routines", "lessons"] as const;
export type NoteArea = (typeof NOTE_AREAS)[number];
export const NOTE_ORIGINS = ["stated", "inferred"] as const;
export type NoteOrigin = (typeof NOTE_ORIGINS)[number];
export const NOTE_FACT_KINDS = ["fact", "preference", "plan", "event"] as const;
export type NoteFactKind = (typeof NOTE_FACT_KINDS)[number];

export type ApplyMode = "background" | "explicit";

export interface ExistingNote {
  readonly id: string;
  readonly area: string;
  readonly slug: string;
  readonly text: string;
  readonly confirmed: boolean;
  readonly version: number;
  readonly source_message_ids: readonly string[];
}

export interface NoteProposal {
  readonly area: string;
  readonly slug: string;
  readonly origin: string;
  readonly fact_kind: string;
  readonly text: string;
  readonly abstract: string;
  readonly quote: string;
  readonly message_id: string;
}

export interface OwnMessage {
  readonly id: string;
  readonly conversation_id: string;
  readonly text: string;
}

export interface NoteSource {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly quote: string;
}

interface NoteContent {
  readonly area: NoteArea;
  readonly slug: string;
  readonly origin: NoteOrigin;
  readonly fact_kind: NoteFactKind;
  readonly text: string;
  readonly abstract: string;
  readonly confirmed: boolean;
  readonly source: NoteSource;
}

export type NoteWrite =
  | ({ readonly kind: "create" } & NoteContent)
  | ({
      readonly kind: "replace";
      readonly note_id: string;
      readonly expected_version: number;
    } & NoteContent)
  | {
      readonly kind: "add_source";
      readonly note_id: string;
      readonly expected_version: number;
      readonly confirm: boolean;
      readonly source: NoteSource;
    };

export type RejectionReason =
  | "invalid_address"
  | "invalid_text"
  | "text_too_long"
  | "message_not_own"
  | "quote_too_short"
  | "quote_too_long"
  | "quote_not_in_own_words"
  | "secret_in_text"
  | "secret_in_quote"
  | "source_already_known"
  | "repeated_in_batch"
  | "confirmed_note_kept"
  | "note_limit";

export interface RejectedProposal {
  readonly index: number;
  readonly reason: RejectionReason;
}

export interface AppliedProposals {
  readonly writes: NoteWrite[];
  readonly rejected: RejectedProposal[];
}

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function addressOf(area: string, slug: string): string {
  return `${area}/${slug}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

function hasSecret(text: string): boolean {
  return findSecretSpans(text).length > 0;
}

function decide(
  proposal: NoteProposal,
  byAddress: ReadonlyMap<string, ExistingNote>,
  messages: ReadonlyMap<string, OwnMessage>,
  touched: ReadonlySet<string>,
  activeCount: number,
  mode: ApplyMode,
): NoteWrite | RejectionReason {
  if (
    !isOneOf(NOTE_AREAS, proposal.area) ||
    !NOTE_SLUG.test(proposal.slug) ||
    !isOneOf(NOTE_ORIGINS, proposal.origin) ||
    !isOneOf(NOTE_FACT_KINDS, proposal.fact_kind)
  )
    return "invalid_address";
  const text = proposal.text.trim();
  if (text.length === 0) return "invalid_text";
  if (text.length > MAX_NOTE_TEXT_CHARS) return "text_too_long";
  const abstract = clip(proposal.abstract.trim() || text, MAX_NOTE_ABSTRACT_CHARS);
  const message = messages.get(proposal.message_id);
  if (!message) return "message_not_own";
  const quote = proposal.quote.trim();
  const checked = checkQuote(quote, ownWords(message.text));
  if (!checked.ok)
    return checked.reason === "quote_not_in_user_words" ? "quote_not_in_own_words" : checked.reason;
  if (hasSecret(text) || hasSecret(abstract)) return "secret_in_text";
  if (hasSecret(quote)) return "secret_in_quote";
  const address = addressOf(proposal.area, proposal.slug);
  if (touched.has(address)) return "repeated_in_batch";
  const source: NoteSource = {
    message_id: message.id,
    conversation_id: message.conversation_id,
    quote,
  };
  const explicit = mode === "explicit";
  const existing = byAddress.get(address);
  const content = {
    area: proposal.area,
    slug: proposal.slug,
    origin: proposal.origin,
    fact_kind: proposal.fact_kind,
    text,
    abstract,
    confirmed: explicit,
    source,
  };
  if (!existing) {
    if (activeCount >= MAX_ACTIVE_NOTES) return "note_limit";
    return { kind: "create", ...content };
  }
  if (existing.source_message_ids.includes(message.id)) return "source_already_known";
  if (normalizeForQuote(existing.text) === normalizeForQuote(text)) {
    return {
      kind: "add_source",
      note_id: existing.id,
      expected_version: existing.version,
      confirm: explicit,
      source,
    };
  }
  if (existing.confirmed && !explicit) return "confirmed_note_kept";
  return {
    kind: "replace",
    note_id: existing.id,
    expected_version: existing.version,
    ...content,
  };
}

export function applyProposals(
  existing: readonly ExistingNote[],
  proposals: readonly NoteProposal[],
  messages: readonly OwnMessage[],
  mode: ApplyMode,
): AppliedProposals {
  const byAddress = new Map(existing.map((note) => [addressOf(note.area, note.slug), note]));
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  const touched = new Set<string>();
  const writes: NoteWrite[] = [];
  const rejected: RejectedProposal[] = [];
  let activeCount = existing.length;
  proposals.forEach((proposal, index) => {
    const decision = decide(proposal, byAddress, byMessage, touched, activeCount, mode);
    if (typeof decision === "string") {
      rejected.push({ index, reason: decision });
      return;
    }
    touched.add(addressOf(proposal.area, proposal.slug));
    if (decision.kind === "create") activeCount += 1;
    writes.push(decision);
  });
  return { writes, rejected };
}
