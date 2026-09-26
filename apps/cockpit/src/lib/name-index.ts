// Names for the things a decision points at.
//
// Two of the three decision sources carry only an id for their target. The
// queue used to render the enum word instead — a skill candidate scoped to a
// workflow showed the literal string "workflow", which tells a person nothing
// about which one. A UUID is not an option either: they are banned from every
// surface, and the sweep fails on one.
//
// So the client resolves ids against the catalogue it already caches. When a
// name cannot be resolved the answer is NOTHING, never the id — that is what
// keeps the `?? item.id` fallback structurally impossible at the call site.

export interface NameIndex {
  workflow: ReadonlyMap<string, string>;
  connector: ReadonlyMap<string, string>;
}

export type NameKind = "workflow" | "connector";

export interface NamedEntity {
  id: string;
  name?: string | null | undefined;
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
    const label = entity.name?.trim() || entity.slug?.trim();
    if (entity.id && label) index.set(entity.id, label);
  }
  return index;
}

/**
 * The workflow's own name for a slug, or null.
 *
 * The chat announces a run as `wf_<slug>`, and the slug is passed through
 * unhumanised on purpose — turning `ga4-daily-report` into "Ga4 Daily Report"
 * reads like a mangling of a name rather than the name itself. But the workflow
 * HAS a name, and the cockpit already holds it. So the slug is resolved rather
 * than dressed up, and when it resolves to nothing the slug stands as it is:
 * an unrecognised slug is still the truest thing available, and inventing a
 * prettier one would answer a question nobody asked.
 */
export function resolveWorkflowNameBySlug(
  entities: readonly { slug?: string | null; name?: string | null }[],
  slug: string,
): string | null {
  const match = entities.find((entity) => entity.slug?.trim() === slug);
  const name = match?.name?.trim();
  return name && name !== slug ? name : null;
}

/** The name, or null. Never the id — the caller renders an em dash instead. */
export function resolveTargetName(
  index: NameIndex,
  kind: NameKind,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return index[kind].get(id) ?? null;
}

/**
 * The target of a skill candidate, whichever scope it was distilled for.
 *
 * A global skill has no target and says so; it is not an unresolved name.
 */
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
