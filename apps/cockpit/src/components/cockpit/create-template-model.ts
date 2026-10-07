import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";
import type { ConnectorSignIn } from "./create-connector-model";

export type SolutionEntry = components["schemas"]["RecipePackEntry"];
export type SolutionConnector = components["schemas"]["RecipeConnectorBinding"];
export type ConnectorTemplate =
  components["schemas"]["ConnectorTemplateListResponse"]["items"][number];
type CreateConnectorBody = components["schemas"]["CreateConnectorBody"];

export const SOLUTIONS_VERTICAL = "solutions";

export type TemplateSignIn = ConnectorSignIn | "elsewhere";

export interface SolutionStep {
  id: string;
  kind: string;
}

export interface BoundaryLine {
  name: string;
  effect: "read" | "write";
  host: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stepsOf(entry: SolutionEntry): Record<string, unknown>[] {
  const steps = record(entry.workflow).steps;
  return Array.isArray(steps) ? steps.map(record) : [];
}

export function solutionSteps(entry: SolutionEntry): SolutionStep[] {
  return stepsOf(entry).map((step) => ({
    id: typeof step.id === "string" ? step.id : "",
    kind: typeof step.kind === "string" ? step.kind : "",
  }));
}

const SOLUTION_TEXT: Readonly<Record<string, { title: TranslationKey; line: TranslationKey }>> = {
  "invoice-attachments-to-drive": {
    title: "solution.invoices.title",
    line: "solution.invoices.line",
  },
  "daily-analytics-report": {
    title: "solution.dailyReport.title",
    line: "solution.dailyReport.line",
  },
  "payment-grants-access": {
    title: "solution.paymentAccess.title",
    line: "solution.paymentAccess.line",
  },
  "webhook-to-slack": { title: "solution.webhookSlack.title", line: "solution.webhookSlack.line" },
  "weekly-run-digest": {
    title: "solution.weeklyDigest.title",
    line: "solution.weeklyDigest.line",
  },
};

export function solutionText(
  entry: Pick<SolutionEntry, "recipe_slug" | "title" | "description">,
  t: (key: TranslationKey) => string,
): { title: string; line: string } {
  const keys = Object.hasOwn(SOLUTION_TEXT, entry.recipe_slug)
    ? SOLUTION_TEXT[entry.recipe_slug]
    : undefined;
  return keys
    ? { title: t(keys.title), line: t(keys.line) }
    : { title: entry.title, line: entry.description };
}

export type SolutionTrigger = "schedule" | "webhook" | "request";

export function solutionTrigger(entry: SolutionEntry): SolutionTrigger {
  const kind = record(record(entry.workflow).trigger).kind;
  return kind === "schedule" || kind === "webhook" ? kind : "request";
}

export function joinNames(names: readonly string[], localeTag: string): string {
  return new Intl.ListFormat(localeTag, { style: "long", type: "conjunction" }).format(names);
}

export function solutionNeeds(entry: SolutionEntry): string[] {
  return [...new Set(entry.connectors.map((connector) => connector.template_name))];
}

export function missingConnectors(entry: SolutionEntry): SolutionConnector[] {
  return entry.connectors.filter((connector) => connector.connector_id === null);
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function writes(step: Record<string, unknown>): boolean {
  if (step.side_effects === "read") return false;
  const method = typeof step.method === "string" ? step.method.toUpperCase() : "GET";
  return method !== "GET" && method !== "HEAD";
}

export function solutionBoundary(entry: SolutionEntry): BoundaryLine[] {
  const lines = new Map<string, BoundaryLine>();
  for (const step of stepsOf(entry)) {
    if (step.kind !== "request" || typeof step.connector_id !== "string") continue;
    const connector = entry.connectors.find(
      (c) => c.connector_id === step.connector_id || c.placeholder === step.connector_id,
    );
    if (!connector) continue;
    const key = connector.placeholder;
    const prior = lines.get(key);
    const effect = prior?.effect === "write" || writes(step) ? "write" : "read";
    lines.set(key, {
      name: connector.connector_name ?? connector.template_name,
      effect,
      host: prior?.host ?? hostOf(step.url),
    });
  }
  return [...lines.values()];
}

export function solutionMatches(
  entry: SolutionEntry,
  text: { title: string; line: string },
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [text.title, text.line, entry.title, entry.description, ...solutionNeeds(entry)]
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

export function solutionDraftBody(entry: SolutionEntry): Record<string, unknown> {
  return {
    definition: { ...record(entry.workflow), slug: entry.recipe_slug },
    recipe: { vertical: SOLUTIONS_VERTICAL, slug: entry.recipe_slug },
  };
}

export function templateSignIn(template: Pick<ConnectorTemplate, "auth_type">): TemplateSignIn {
  if (template.auth_type === "oauth2") return "account";
  if (template.auth_type === "bearer" || template.auth_type === "header") return "key";
  if (template.auth_type === "none") return "none";
  return "elsewhere";
}

export const SIGN_IN_LABEL: Record<TemplateSignIn, TranslationKey> = {
  account: "create.template.signIn.account",
  key: "create.template.signIn.key",
  none: "create.template.signIn.none",
  elsewhere: "create.template.signIn.elsewhere",
};

export function templateKeyHeader(
  template: Pick<ConnectorTemplate, "credential_hints">,
): string | null {
  return template.credential_hints.find((hint) => hint.header_name)?.header_name ?? null;
}

export function templateNeedsAddress(
  template: Pick<ConnectorTemplate, "base_url" | "driver">,
): boolean {
  if (template.driver !== "http" && template.driver !== "graphql") return false;
  return !template.base_url || template.base_url.includes("{");
}

export function templateMatches(template: ConnectorTemplate, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    template.name,
    template.slug,
    template.category,
    template.description,
    ...template.aliases,
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

export function sortedTemplates(templates: readonly ConnectorTemplate[]): ConnectorTemplate[] {
  return [...templates].sort((a, b) => a.name.localeCompare(b.name));
}

export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function templateConnectorBody(
  template: Pick<ConnectorTemplate, "slug" | "name" | "driver" | "auth_type">,
  taken: ReadonlySet<string>,
  address?: string,
): CreateConnectorBody {
  const slug = freeSlug(template.slug, taken);
  const suffix = slug === template.slug ? "" : ` ${slug.slice(template.slug.length + 1)}`;
  return {
    name: `${template.name}${suffix}`,
    slug,
    driver: template.driver,
    environment: "prod",
    auth_type: template.auth_type,
    template_slug: template.slug,
    ...(address?.trim() ? { base_url: address.trim() } : {}),
  };
}

const HTTPS = /^https:\/\/\S+\.\S+/;

export function templateConnectProblem(p: {
  signIn: TemplateSignIn;
  needsAddress: boolean;
  address: string;
  secret: string;
  header: string | null;
  callbackUrl: string | null;
}): TranslationKey | null {
  if (p.needsAddress && !HTTPS.test(p.address.trim())) return "create.connector.addressInvalid";
  if (p.signIn === "key" && !p.secret.trim()) return "create.connector.secretMissing";
  if (p.signIn === "key" && p.header !== null && !p.header.trim()) {
    return "create.template.headerMissing";
  }
  if (p.signIn === "account" && !p.callbackUrl) return "signIn.failed.publicUrl";
  return null;
}
