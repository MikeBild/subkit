// Deterministic fast path for next-message suggestions: when the
// assistant's last reply ends in an explicit offer pattern
// ("Want me to commit + push it?", "Should I run the tests?"), we
// derive the suggestion from the captured action span without ever
// calling a model.
//
// Empirically the most common conversational turns end this way, so
// every offer-parse hit is a zero-token, sub-millisecond suggestion.
// On a miss the caller falls back to a small-model generation — the
// fast path is *not* a silent fallback for the contract; it is an
// auditable optimization carrying its own `reason` tag
// (`offer-detected` or `offer-skill`) so the structured log records
// which path produced the suggestion.
//
// Localization: English-only in v1. Adding another language means
// adding to OFFER_PATTERNS and updating the test corpus — there is no
// other coupling.

export type OfferParseKind = "text" | "slash";

export interface ParsedOffer {
  /** The text the user can accept (or the slash command, when `kind` is `slash`). */
  suggestion: string;
  kind: OfferParseKind;
  /** The captured action span verbatim (lowercased), without punctuation. */
  offered_action: string;
  /** Distinguishes plain text matches from skill-resolved slash matches. */
  reason: "offer-detected" | "offer-skill";
}

export interface LoadedSkillHint {
  /** Slug used for the slash invocation, e.g. `release-notes`. */
  slug: string;
  /**
   * Verbs the skill exposes as actions. Matched case-insensitively against
   * the *first* word of the captured offer action.
   */
  verbs: ReadonlyArray<string>;
}

export interface OfferParseInput {
  assistant_text: string;
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
}

// Patterns are anchored on common English offer constructions. Each
// pattern uses a non-greedy capture for the action span so trailing
// content after the question mark is ignored.
//
// Order matters: longer / more-specific phrasings come first so a
// generic "want to X?" inside "do you want me to X?" doesn't steal
// the match.
const OFFER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwould you like me to\s+([^?]+?)\??\s*\?/i,
  /\bdo you want me to\s+([^?]+?)\??\s*\?/i,
  /\bwant me to\s+([^?]+?)\??\s*\?/i,
  /\bshall i\s+([^?]+?)\??\s*\?/i,
  /\bshould i\s+([^?]+?)\??\s*\?/i,
  /\bwant to\s+([^?]+?)\??\s*\?/i,
];

const FENCE_LINE = /^```/;

/**
 * Strip fenced code blocks so offer patterns inside fenced examples don't
 * trigger a false positive. Keeps the rest of the text in place.
 */
function stripFencedBlocks(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_LINE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Returns the *last* match of any offer pattern in the text, since the
 * assistant's most recent question is the most relevant offer.
 */
function findLastOffer(text: string): { action: string } | null {
  let best: { action: string; index: number } | null = null;
  for (const pattern of OFFER_PATTERNS) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
      const action = (match[1] ?? "").trim();
      if (action.length > 0 && (best === null || match.index > best.index)) {
        best = { action, index: match.index };
      }
      match = re.exec(text);
    }
  }
  return best ? { action: best.action } : null;
}

function normalizeAction(raw: string): string {
  // Drop trailing punctuation (except `?` and `!` already stripped by the regex)
  // and collapse internal whitespace. Leave casing as-is — the user types the
  // action the way it reads naturally.
  return raw
    .replace(/[\s.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tryResolveSkill(
  action: string,
  loadedSkills: ReadonlyArray<LoadedSkillHint>,
): { slug: string; verb: string } | null {
  const firstWord = action.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (firstWord.length === 0) return null;
  for (const skill of loadedSkills) {
    for (const verb of skill.verbs) {
      if (verb.toLowerCase() === firstWord) {
        return { slug: skill.slug, verb };
      }
    }
  }
  return null;
}

export function parseOffer(input: OfferParseInput): ParsedOffer | null {
  const cleaned = stripFencedBlocks(input.assistant_text ?? "");
  const offer = findLastOffer(cleaned);
  if (!offer) return null;

  const action = normalizeAction(offer.action);
  if (action.length === 0) return null;

  const loaded = input.loaded_skills ?? [];
  if (loaded.length > 0) {
    const skill = tryResolveSkill(action, loaded);
    if (skill) {
      return {
        suggestion: `/skill ${skill.slug} ${skill.verb}`,
        kind: "slash",
        offered_action: action.toLowerCase(),
        reason: "offer-skill",
      };
    }
  }

  return {
    suggestion: action,
    kind: "text",
    offered_action: action.toLowerCase(),
    reason: "offer-detected",
  };
}
