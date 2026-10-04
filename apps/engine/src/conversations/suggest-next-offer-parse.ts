export type OfferParseKind = "text" | "slash";

export interface ParsedOffer {
  suggestion: string;
  kind: OfferParseKind;
  offered_action: string;
  reason: "offer-detected" | "offer-skill";
}

export interface LoadedSkillHint {
  slug: string;
  verbs: ReadonlyArray<string>;
}

export interface OfferParseInput {
  assistant_text: string;
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
}

const OFFER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwould you like me to\s+([^?]+?)\??\s*\?/gi,
  /\bdo you want me to\s+([^?]+?)\??\s*\?/gi,
  /\bwant me to\s+([^?]+?)\??\s*\?/gi,
  /\bshall i\s+([^?]+?)\??\s*\?/gi,
  /\bshould i\s+([^?]+?)\??\s*\?/gi,
  /\bwant to\s+([^?]+?)\??\s*\?/gi,
];

const FENCE_LINE = /^```/;

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

function findLastOffer(text: string): { action: string } | null {
  let best: { action: string; index: number } | null = null;
  for (const re of OFFER_PATTERNS) {
    re.lastIndex = 0;
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
