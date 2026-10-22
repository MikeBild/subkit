import { z } from "@hono/zod-openapi";
import { boundaryGrowth } from "./authority-inheritance.ts";
import type { WorkflowEffectManifest } from "./effect-manifest.ts";

type Effect = WorkflowEffectManifest["effects"][number];

const EffectKindSchema = z.enum(["read", "write", "unknown", "destructive"]);

export const AuthorityEffectChangeSchema = z
  .object({
    step_id: z.string(),
    call_path: z.array(z.string()).optional(),
    change: z.enum(["added", "widened", "unchanged", "removed"]),
    effect: EffectKindSchema,
    subject: z.string().nullable(),
    previous: z
      .object({
        effect: EffectKindSchema,
        max_calls: z.number().int().nullable(),
        max_requests: z.number().int().nullable(),
      })
      .optional(),
  })
  .openapi("AuthorityEffectChange");
export type AuthorityEffectChange = z.infer<typeof AuthorityEffectChangeSchema>;

export const AuthorityEffectChangesBaseSchema = z
  .object({
    workflow_version_id: z.string().uuid(),
    version: z.number().int(),
    approved: z.boolean(),
  })
  .openapi("AuthorityEffectChangesBase");

const RISK = { destructive: 0, unknown: 1, write: 2, read: 3 } as const;
const RANK = { read: 0, write: 1, destructive: 2, unknown: 3 } as const;
const CHANGE_ORDER = { added: 0, widened: 1, removed: 2, unchanged: 3 } as const;
const GRAPHQL_OPERATIONS = new Set(["query", "mutation", "subscription"]);

const keyOf = (effect: Effect) => JSON.stringify([effect.step_id, effect.call_path ?? []]);

const lastStatic = (parts: Array<string | null | { var: string }>) =>
  parts.findLast((part): part is string => typeof part === "string" && part !== "") ?? null;

export function effectSubject(effect: Effect): string | null {
  if (effect.driver === "graphql" || GRAPHQL_OPERATIONS.has(effect.operation)) return null;
  if (effect.boundary) return lastStatic(effect.boundary.segments);
  if (effect.read_path) return lastStatic(effect.read_path.segments);
  if (effect.storage) return lastStatic(effect.storage.key_prefix.split("/"));
  if (!effect.target) return null;
  try {
    return lastStatic(new URL(effect.target).pathname.split("/"));
  } catch {
    return null;
  }
}

const single = (manifest: WorkflowEffectManifest, effect: Effect): WorkflowEffectManifest => {
  const { caller_guards: _guards, ...rest } = manifest;
  return { ...rest, effects: [effect] };
};

function widened(
  base: WorkflowEffectManifest,
  from: Effect,
  next: WorkflowEffectManifest,
  to: Effect,
) {
  return (
    RANK[to.effect] > RANK[from.effect] ||
    boundaryGrowth(single(base, from), single(next, to)).length > 0
  );
}

const describe = (
  effect: Effect,
  change: AuthorityEffectChange["change"],
  previous?: Effect,
): AuthorityEffectChange => ({
  step_id: effect.step_id,
  ...(effect.call_path ? { call_path: [...effect.call_path] } : {}),
  change,
  effect: effect.effect,
  subject: effectSubject(effect),
  ...(previous
    ? {
        previous: {
          effect: previous.effect,
          max_calls: previous.boundary?.max_calls ?? null,
          max_requests: previous.boundary?.pagination?.max_requests ?? null,
        },
      }
    : {}),
});

export function effectChanges(
  base: WorkflowEffectManifest,
  next: WorkflowEffectManifest,
): AuthorityEffectChange[] {
  const previous = new Map(base.effects.map((effect) => [keyOf(effect), effect]));
  const current = new Set(next.effects.map(keyOf));
  const changes = [
    ...next.effects.map((effect) => {
      const from = previous.get(keyOf(effect));
      if (!from) return describe(effect, "added");
      return widened(base, from, next, effect)
        ? describe(effect, "widened", from)
        : describe(effect, "unchanged");
    }),
    ...base.effects
      .filter((effect) => !current.has(keyOf(effect)))
      .map((effect) => describe(effect, "removed")),
  ];
  const sortKey = (entry: AuthorityEffectChange) =>
    JSON.stringify([entry.step_id, entry.call_path ?? []]);
  return changes.sort(
    (left, right) =>
      RISK[left.effect] - RISK[right.effect] ||
      CHANGE_ORDER[left.change] - CHANGE_ORDER[right.change] ||
      (sortKey(left) < sortKey(right) ? -1 : sortKey(left) > sortKey(right) ? 1 : 0),
  );
}
