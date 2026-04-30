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

function computeSpecificity(pattern: string): number {
  const base = pattern.length;
  const wildcards = (pattern.match(/\[|\.\*|\.\+|\\w|\\d|\\s|\[\^/g) ?? []).length;
  const literalHost = pattern.match(/^\^?https?:\\\/\\\/([a-z0-9.-]+)/i)?.[1];
  const fixedHostSegments = literalHost
    ? literalHost.split(/\\\./).filter((s) => s.length > 0).length
    : 0;
  return base - 3 * wildcards + 5 * fixedHostSegments;
}

function compileTemplates(templates: ConnectorTemplate[]) {
  return templates.map((template) => {
    const builtin = loadCompiledTemplates().find((entry) => entry.template.slug === template.slug);
    if (builtin && builtin.template.url_pattern === template.url_pattern) return builtin;
    return {
      template,
      urlRe: template.url_pattern ? new RegExp(template.url_pattern) : null,
      specificity: template.url_pattern ? computeSpecificity(template.url_pattern) : 0,
    };
  });
}

function rank(rawUrl: string, templates?: ConnectorTemplate[]): TemplateUrlMatch[] {
  const compiled = templates ? compileTemplates(templates) : loadCompiledTemplates();
  const out: TemplateUrlMatch[] = [];
  for (const { template, urlRe, specificity } of compiled) {
    // Templates without a url_pattern are unreachable via URL match.
    if (!urlRe) continue;
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
export function matchTemplateByUrl(
  rawUrl: string,
  templates?: ConnectorTemplate[],
): TemplateUrlMatch | null {
  if (!looksLikeUrl(rawUrl)) {
    // Allow postgres/mysql/redis DSNs too — they are not URL objects, but
    // templates may have url_pattern starting with `^postgres:`.
    if (!/^[a-z][a-z0-9+\-.]*:\/\//.test(rawUrl)) return null;
  }
  const matches = rank(rawUrl, templates);
  return matches[0] ?? null;
}

/**
 * Return up to `limit` best matches for a raw URL, sorted by score desc.
 */
export function matchTemplatesByUrl(
  rawUrl: string,
  limit = 5,
  templates?: ConnectorTemplate[],
): TemplateUrlMatch[] {
  if (!looksLikeUrl(rawUrl) && !/^[a-z][a-z0-9+\-.]*:\/\//.test(rawUrl)) return [];
  if (limit < 1) return [];
  const matches = rank(rawUrl, templates);
  return matches.slice(0, limit);
}
