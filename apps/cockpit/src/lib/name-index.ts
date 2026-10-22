export interface NameIndex {
  workflow: ReadonlyMap<string, string>;
  connector: ReadonlyMap<string, string>;
}

export type NameKind = "workflow" | "connector";

export interface NamedEntity {
  id: string;
  name?: string | null | undefined;
  display_name?: string | null | undefined;
  slug?: string | null | undefined;
}

export const EMPTY_NAME_INDEX: NameIndex = { workflow: new Map(), connector: new Map() };

export function buildNameIndex(
  workflows: readonly NamedEntity[],
  connectors: readonly NamedEntity[],
): NameIndex {
  return {
    workflow: indexOf(workflows),
    connector: indexOf(connectors),
  };
}

function indexOf(entities: readonly NamedEntity[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entity of entities) {
    const label = entity.display_name?.trim() || entity.name?.trim() || entity.slug?.trim();
    if (entity.id && label) index.set(entity.id, label);
  }
  return index;
}

export function resolveWorkflowNameBySlug(
  entities: readonly { slug?: string | null; name?: string | null }[],
  slug: string,
): string | null {
  const match = entities.find((entity) => entity.slug?.trim() === slug);
  const name = match?.name?.trim();
  return name && name !== slug ? name : null;
}

export function resolveTargetName(
  index: NameIndex,
  kind: NameKind,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return index[kind].get(id) ?? null;
}

export function skillTargetName(
  index: NameIndex,
  candidate: {
    scope: string;
    workflow_id?: string | null | undefined;
    connector_id?: string | null | undefined;
  },
): string | null {
  if (candidate.scope === "workflow") {
    return resolveTargetName(index, "workflow", candidate.workflow_id);
  }
  if (candidate.scope === "connector") {
    return resolveTargetName(index, "connector", candidate.connector_id);
  }
  return null;
}
