// Template matching by URL.
//
// Complements the text-scoring match in `connector-template-intelligence.ts`.
// When the operator pastes a concrete API URL (e.g.
// `https://api.stripe.com/v1/charges`), we compile every template's
// `url_pattern` into a RegExp and return the best match. "Best" means:
// 1) the pattern matched,
// 2) highest specificity + matched-segment-length score,
// 3) deterministic slug-alphabetical tie-break.
//
// The compiled cache lives in `templates.ts` (`loadCompiledTemplates`); this
// module only ranks and filters.

import type { ConnectorTemplate } from "./templates.ts";
import { loadCompiledTemplates } from "./templates.ts";

export interface TemplateUrlMatch {
  template: ConnectorTemplate;
  score: number;
  matched_segment: string;
}

function rank(rawUrl: string): TemplateUrlMatch[] {
  const compiled = loadCompiledTemplates();
  const out: TemplateUrlMatch[] = [];
  for (const { template, urlRe, specificity } of compiled) {
    const m = urlRe.exec(rawUrl);
    if (!m) continue;
    out.push({
      template,
      score: specificity + m[0].length,
      matched_segment: m[0],
    });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.template.slug.localeCompare(b.template.slug);
  });
  return out;
}

function looksLikeUrl(s: string): boolean {
  if (typeof s !== "string") return false;
  if (!s) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the single best template for a raw URL, or null when no template
 * matches. Invalid URLs return null.
 */
export function matchTemplateByUrl(rawUrl: string): TemplateUrlMatch | null {
  if (!looksLikeUrl(rawUrl)) {
    // Allow postgres/mysql/redis DSNs too — they are not URL objects, but
    // templates may have url_pattern starting with `^postgres:`.
    if (!/^[a-z][a-z0-9+\-.]*:\/\//.test(rawUrl)) return null;
  }
  const matches = rank(rawUrl);
  return matches[0] ?? null;
}

/**
 * Return up to `limit` best matches for a raw URL, sorted by score desc.
 */
export function matchTemplatesByUrl(rawUrl: string, limit = 5): TemplateUrlMatch[] {
  if (!looksLikeUrl(rawUrl) && !/^[a-z][a-z0-9+\-.]*:\/\//.test(rawUrl)) return [];
  if (limit < 1) return [];
  const matches = rank(rawUrl);
  return matches.slice(0, limit);
}
