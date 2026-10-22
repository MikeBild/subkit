import { humanize } from "@/lib/effect-label";
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

export function serviceInitial(name: string): string {
  const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0];
  return letter ? letter.toLocaleUpperCase() : "?";
}
