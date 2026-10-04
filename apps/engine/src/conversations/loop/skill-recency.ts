import { z } from "zod";

export interface LoadedSkillEntry {
  slug: string;
  last_turn: number;
}

const loadedSkillEntrySchema = z.object({
  slug: z.string().min(1),
  last_turn: z.number().int().nonnegative(),
});

export function parseLoadedSkills(
  raw: unknown,
  onInvalid?: (info: { dropped: number; raw: unknown }) => void,
): LoadedSkillEntry[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    onInvalid?.({ dropped: 0, raw });
    return [];
  }
  const out: LoadedSkillEntry[] = [];
  let dropped = 0;
  for (const item of raw) {
    const parsed = loadedSkillEntrySchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else dropped++;
  }
  if (dropped > 0) onInvalid?.({ dropped, raw });
  return out;
}

export const SKILL_FULL_BODY_RECENCY_K = 3;

export const SKILL_RETENTION_TURNS = SKILL_FULL_BODY_RECENCY_K * 8;

export function applyRecency(
  loaded: readonly LoadedSkillEntry[],
  currentTurn: number,
  refresh: ReadonlySet<string>,
  additions: readonly string[],
  neverPrune: ReadonlySet<string>,
): {
  next: LoadedSkillEntry[];
  fullBodySet: string[];
  membership: string[];
} {
  const bySlug = new Map<string, number>();
  for (const e of loaded) {
    bySlug.set(e.slug, refresh.has(e.slug) ? currentTurn : e.last_turn);
  }
  for (const slug of additions) bySlug.set(slug, currentTurn);

  const next: LoadedSkillEntry[] = [];
  for (const [slug, last_turn] of bySlug) {
    const age = currentTurn - last_turn;
    if (age >= SKILL_RETENTION_TURNS && !neverPrune.has(slug)) continue;
    next.push({ slug, last_turn });
  }

  const fullBodySet = next
    .filter((e) => currentTurn - e.last_turn < SKILL_FULL_BODY_RECENCY_K)
    .map((e) => e.slug);
  const membership = next.map((e) => e.slug);
  return { next, fullBodySet, membership };
}
