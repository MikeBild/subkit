import type { ConnectorTemplate } from "./templates.ts";
import { loadCompiledTemplates } from "./templates.ts";

export interface TemplateUrlMatch {
  template: ConnectorTemplate;
  score: number;
  matched_segment: string;
  recipes: ReadonlyArray<{
    slug: string;
    title: string;
    description: string;
    intent_keywords: ReadonlyArray<string>;
  }>;
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
    if (!urlRe) continue;
    const m = urlRe.exec(rawUrl);
    if (!m) continue;
    out.push({
      template,
      score: specificity + m[0].length,
      matched_segment: m[0],
      recipes: template.recipes.map((r) => ({
        slug: r.slug,
        title: r.title,
        description: r.description,
        intent_keywords: r.intent_keywords,
      })),
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

export function matchTemplateByUrl(
  rawUrl: string,
  templates?: ConnectorTemplate[],
): TemplateUrlMatch | null {
  if (!looksLikeUrl(rawUrl)) {
    if (!/^[a-z][a-z0-9+\-.]*:\/\//.test(rawUrl)) return null;
  }
  const matches = rank(rawUrl, templates);
  return matches[0] ?? null;
}

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
