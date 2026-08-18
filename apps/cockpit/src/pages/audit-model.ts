import type { TranslationKey } from "@/lib/i18n";

/**
 * Which audited resource types the Cockpit can actually open.
 *
 * An execution is deliberately absent: there is no run detail route, and a
 * link that lands nowhere is worse than plain text.
 */
const RESOURCE_ROUTES: Record<string, string> = {
  workflow: "workflows",
  connector: "connectors",
  knowledge_source: "knowledge",
  skill: "skills",
  file: "files",
  conversation: "chat",
};

export function auditResourceHref(resourceType: string, resourceId: string | null): string | null {
  if (!resourceId) return null;
  const route = RESOURCE_ROUTES[resourceType];
  return route ? `/cockpit/${route}/${encodeURIComponent(resourceId)}` : null;
}

const ACTOR_KEYS: Record<string, TranslationKey> = {
  user: "audit.actor.user",
  system_account: "audit.actor.systemAccount",
  system: "audit.actor.system",
};

export function actorTypeKey(actorType: string): TranslationKey {
  return ACTOR_KEYS[actorType] ?? "common.unknown";
}

const RESOURCE_KEYS: Record<string, TranslationKey> = {
  workflow: "nav.workflows",
  connector: "resource.connectors.title",
  knowledge_source: "nav.knowledge",
  skill: "nav.skills",
  file: "nav.files",
  conversation: "nav.chat",
  execution: "nav.runs",
  api_key: "nav.apiAccess",
  role: "nav.access",
  user: "nav.people",
  settings: "nav.settings",
};

export function resourceTypeKey(resourceType: string): TranslationKey {
  return RESOURCE_KEYS[resourceType] ?? "common.unknown";
}
