import type { ConversationReference } from "@/api/client";

const REFERENCE_TYPES: readonly ConversationReference["type"][] = [
  "workflow",
  "connector",
  "skill",
  "knowledge_source",
  "execution",
  "intake_item",
];

export type ReferencedResource = ConversationReference & {
  at: string;
  unresolved: boolean;
};

interface MessageWithReferences {
  role: string;
  parts: readonly unknown[];
  created_at: string;
}

function referenceList(value: unknown): ConversationReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (reference): reference is ConversationReference =>
      !!reference &&
      typeof reference === "object" &&
      typeof (reference as { id?: unknown }).id === "string" &&
      typeof (reference as { label?: unknown }).label === "string" &&
      REFERENCE_TYPES.includes((reference as { type?: unknown }).type as never),
  );
}

export function referencesFromPart(part: unknown): {
  references: ConversationReference[];
  unresolved: ConversationReference[];
} {
  if (!part || typeof part !== "object") return { references: [], unresolved: [] };
  const record = part as Record<string, unknown>;
  return {
    references: referenceList(record.references),
    unresolved: referenceList(record.unresolved_references),
  };
}

export function collectReferencedResources(
  messages: readonly MessageWithReferences[],
): ReferencedResource[] {
  const latest = new Map<string, ReferencedResource & { order: number }>();
  let order = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      const { references, unresolved } = referencesFromPart(part);
      const unresolvedKeys = new Set(unresolved.map((item) => `${item.type}:${item.id}`));
      const referenceKeys = new Set(references.map((item) => `${item.type}:${item.id}`));
      const items = [
        ...references,
        ...unresolved.filter((item) => !referenceKeys.has(`${item.type}:${item.id}`)),
      ];
      for (const item of items) {
        const key = `${item.type}:${item.id}`;
        latest.set(key, {
          ...item,
          at: message.created_at,
          unresolved: unresolvedKeys.has(key),
          order: order++,
        });
      }
    }
  }
  return [...latest.values()]
    .sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order)
    .map(({ order: _order, ...resource }) => resource);
}

interface NamedResource {
  id: string;
  kind: string;
  label: string;
}

export function namedResources(sources: {
  target:
    | { id?: string | null; name?: string | null; slug?: string | null; kind: string }
    | null
    | undefined;
  created: ReadonlyArray<{ id: string; kind: string; name?: string | null; slug?: string | null }>;
  referenced: readonly ReferencedResource[];
}): Map<string, NamedResource> {
  const named = new Map<string, NamedResource>();
  const target = sources.target;
  const targetLabel = target?.name || target?.slug;
  if (target?.id && targetLabel && target.kind !== "none")
    named.set(target.id, { id: target.id, kind: target.kind, label: targetLabel });
  for (const resource of sources.created) {
    const label = resource.name || resource.slug;
    if (label) named.set(resource.id, { id: resource.id, kind: resource.kind, label });
  }
  for (const resource of sources.referenced) {
    if (resource.unresolved) continue;
    named.set(resource.id, { id: resource.id, kind: resource.type, label: resource.label });
  }
  return named;
}
