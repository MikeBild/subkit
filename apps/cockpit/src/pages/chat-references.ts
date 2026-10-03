import type { ConversationReference } from "@/api/client";

/** Every kind of object an `@`-mention can name. */
const REFERENCE_TYPES: readonly ConversationReference["type"][] = [
  "workflow",
  "connector",
  "skill",
  "knowledge_source",
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

export function referenceList(value: unknown): ConversationReference[] {
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
