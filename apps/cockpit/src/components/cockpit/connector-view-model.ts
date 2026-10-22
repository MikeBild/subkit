import { humanize } from "@/lib/effect-label";
import type { TranslationKey } from "@/lib/i18n";
import { presentAddress } from "@/pages/connector-detail-model";
import type { ConnectorTemplate } from "./create-template-model";

export const POPULAR_TEMPLATES = 8;

export function popularTemplates<T extends { name: string; recipes: readonly unknown[] }>(
  templates: readonly T[],
  limit = POPULAR_TEMPLATES,
): T[] {
  return [...templates]
    .sort((a, b) => b.recipes.length - a.recipes.length || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function serviceHost(address: string | null): string | null {
  if (!address) return null;
  const shown = presentAddress(address).shown;
  try {
    return new URL(shown).host || null;
  } catch {
    return null;
  }
}

export function toolTitle(tool: { name: string; title?: string | null }): string {
  const title = tool.title?.trim();
  return title || humanize(tool.name) || tool.name;
}

export function askingTools(names: readonly string[], trusted: readonly string[]): number {
  const free = new Set(trusted);
  return names.filter((name) => !free.has(name)).length;
}

export function templateFor<T extends Pick<ConnectorTemplate, "slug">>(
  templates: readonly T[],
  slug: string | null,
): T | null {
  if (!slug) return null;
  return templates.find((template) => template.slug === slug) ?? null;
}

const SHORT_WAY: Readonly<Record<string, TranslationKey>> = {
  oauth2: "create.connector.signIn.account",
  bearer: "create.connector.signIn.key",
  header: "create.connector.signIn.key",
  none: "create.connector.signIn.none",
  query: "connectorLabel.auth.query",
  basic: "connectorLabel.auth.basic",
  oauth2_client: "connectorLabel.auth.oauth2_client",
  oauth2_private_key: "connectorLabel.auth.oauth2_private_key",
  signed_jwt: "connectorLabel.auth.signed_jwt",
  aws_sigv4: "connectorLabel.auth.aws_sigv4",
};

export function signInChipKey(authType: string | null): TranslationKey {
  return (authType && SHORT_WAY[authType]) || "connectorDetail.connection.signIn";
}

export function serviceInitial(name: string): string {
  const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0];
  return letter ? letter.toLocaleUpperCase() : "?";
}
