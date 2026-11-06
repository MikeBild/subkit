import { findTemplateAliasMatches } from "../connectors/template-resolver.ts";
import type { ConnectorTemplate } from "../connectors/templates.ts";
import { loadBuiltinTemplates } from "../connectors/templates.ts";
import type { AuthType, DriverName } from "../connectors/types.ts";

const TEMPLATE_PLACEHOLDER_RE = /\{([a-zA-Z0-9._-]+)\}/g;
const GENERIC_MATCH_TOKENS = new Set([
  "api",
  "app",
  "auth",
  "cloud",
  "connector",
  "data",
  "endpoint",
  "graphql",
  "http",
  "https",
  "integration",
  "private",
  "prod",
  "production",
  "rest",
  "service",
  "sync",
  "system",
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

export function normalizeForExactMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function scoreConnectorTemplate(
  template: ConnectorTemplate,
  query: string,
  explicitDriver?: DriverName,
): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let score = 0;
  if (explicitDriver && template.driver === explicitDriver) score += 6;
  if (template.slug === q) score += 16;
  if (template.name.toLowerCase() === q) score += 16;
  if (findTemplateAliasMatches(template, q)) score += 14;
  if (template.slug.includes(q)) score += 8;
  if (template.name.toLowerCase().includes(q)) score += 8;
  if (template.description.toLowerCase().includes(q)) score += 4;
  if (template.category?.toLowerCase().includes(q)) score += 3;
  const haystack = [
    template.slug,
    template.name.toLowerCase(),
    template.description.toLowerCase(),
    template.category?.toLowerCase() ?? "",
    ...template.aliases.map((alias) => alias.toLowerCase()),
    ...template.tags.map((tag) => tag.toLowerCase()),
  ];
  for (const token of tokenize(q)) {
    for (const candidate of haystack) {
      if (candidate === token) score += 4;
      else if (candidate.includes(token)) score += 2;
    }
  }
  for (const kw of template.keywords) {
    const kwl = kw.toLowerCase();
    if (kwl === q) score += 10;
    else if (kwl.includes(q)) score += 4;
  }
  return score;
}

export function extractTemplatePlaceholders(value?: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const match of value.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    seen.add(name);
  }
  return [...seen];
}

export function suggestConnectorTemplates(args: {
  query: string;
  limit: number;
  explicitDriver?: DriverName;
  templates?: ConnectorTemplate[];
}): Array<{ template: ConnectorTemplate; score: number }> {
  const templates = args.templates ?? loadBuiltinTemplates();
  return templates
    .map((template) => ({
      template,
      score: scoreConnectorTemplate(template, args.query, args.explicitDriver),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit);
}

export function pickBestConnectorTemplate(
  query: string,
  explicitDriver?: DriverName,
  templates?: ConnectorTemplate[],
): { template: ConnectorTemplate; score: number } | null {
  return (
    suggestConnectorTemplates({
      query,
      limit: 1,
      ...(explicitDriver ? { explicitDriver } : {}),
      ...(templates ? { templates } : {}),
    })[0] ?? null
  );
}

export function shouldAutoSelectConnectorTemplate(args: {
  template: ConnectorTemplate;
  score: number;
  name: string;
  description?: string;
}): boolean {
  const normalizedName = normalizeForExactMatch(args.name);
  const normalizedTemplateName = normalizeForExactMatch(args.template.name);
  if (normalizedName.length > 0) {
    if (args.template.slug === normalizedName) return true;
    if (normalizedTemplateName === normalizedName) return true;
    if (findTemplateAliasMatches(args.template, normalizedName)) return true;
  }

  const query = [args.name, args.description]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  if (!query.trim()) return false;

  const templateTokens = new Set(
    tokenize(`${args.template.slug} ${args.template.name} ${args.template.aliases.join(" ")}`)
      .filter((token) => token.length >= 4)
      .filter((token) => !GENERIC_MATCH_TOKENS.has(token)),
  );
  const matchedMeaningfulTokens = new Set(
    tokenize(query)
      .filter((token) => token.length >= 4)
      .filter((token) => !GENERIC_MATCH_TOKENS.has(token))
      .filter((token) => templateTokens.has(token)),
  );
  if (matchedMeaningfulTokens.size === 0) return false;

  return args.score >= 14;
}

export function allowedTemplateAuthTypes(template: ConnectorTemplate): AuthType[] {
  const authTypes = new Set<AuthType>();
  authTypes.add(template.auth_type);
  for (const option of template.auth_options) {
    authTypes.add(option.auth_type);
  }
  return [...authTypes];
}

export function defaultTemplateAuthType(template: ConnectorTemplate): AuthType {
  return template.auth_options[0]?.auth_type ?? template.auth_type;
}

export function inferTemplateRequiredFields(template: ConnectorTemplate): string[] {
  const required = new Set<string>(extractTemplatePlaceholders(template.base_url));
  if (template.driver === "postgres") required.add("dsn");
  if (template.driver === "s3") {
    required.add("bucket");
    required.add("region");
  }
  return [...required];
}

export function inferAuthTypeFromDescription(description?: string | null): AuthType | null {
  if (!description) return null;
  const d = description.toLowerCase();
  if (/\boauth\b|\boauth2\b/.test(d)) return "oauth2";
  if (/\bbasic auth\b|\busername\b|\bpassword\b|\bemail\b/.test(d)) return "basic";
  if (/\bbearer\b|\bpersonal access token\b/.test(d)) return "bearer";
  if (/\bquery\b/.test(d)) return "query";
  if (/\bheader\b/.test(d)) return "header";
  if (/\bpublic\b|\bno auth\b|\bunauthenticated\b/.test(d)) return "none";
  return null;
}
