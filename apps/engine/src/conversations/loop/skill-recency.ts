// Recency-aware full-body skill loading (the "smart" skill loader).
//
// `conversations.loaded_skills` is a one-way ratchet no more: rather
// than re-rendering every ever-loaded skill's FULL body on every turn,
// the loop renders the full body only while a skill is RELEVANT to the
// current turn. Relevance is recency: a skill is full-body iff it was
// last touched within K turns. Everything else falls back to the
// always-present skill INDEX (`formatSkillIndex` + the assembler's
// "Loaded" index block) — nothing is truncated, nothing disappears.
//
// A loaded entry's `last_turn` is refreshed when it is (a) a
// baseline-activated skill, or (b) re-affirmed by this turn's signals
// via the `activates_when` engine (see `reaffirmLoadedForTurn`). New
// autoload / `load_skill` additions enter with `last_turn = currentTurn`
// so they are full-body immediately.
//
// This module owns the pure recency math so the loop can stay thin and
// the algorithm stays unit-testable without the full `streamText` loop.

import { z } from "zod";

/** One persisted `loaded_skills` entry. */
export interface LoadedSkillEntry {
  slug: string;
  last_turn: number;
}

/** Runtime guard for a single persisted entry (the `jsonb` column shape). */
const loadedSkillEntrySchema = z.object({
  slug: z.string().min(1),
  last_turn: z.number().int().nonnegative(),
});

/**
 * Validate a raw `conversations.loaded_skills` value into typed entries,
 * DROPPING anything malformed.
 *
 * The column is `jsonb`. Migration `0001_condemned_maestro` converts the
 * legacy `string[]` ratchet to the `{slug,last_turn}` shape, but a row can
 * still escape it (rollback, restore-from-old-backup, a dev DB on a stale
 * branch). Casting such a row straight to `LoadedSkillEntry[]` poisons the
 * prompt silently — `.map((e) => e.slug)` yields `undefined` for the
 * string form, which then breaks membership and the rendered context. A
 * degraded recency window is recoverable; a corrupt prompt is not, so
 * validate at every read boundary and drop bad entries rather than trust
 * the cast (AGENTS.md "Zod at boundaries" — DB shape that crosses into LLM
 * context is a boundary too).
 *
 * `onInvalid` lets the impure caller emit a structured-logger warning
 * without this pure module taking a logger dependency.
 */
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

/**
 * Full-body recency window. A loaded skill renders its FULL body while
 * `(currentTurn - last_turn) < K`; outside the window it falls back to
 * the skill INDEX and re-promotes on the next match or `load_skill`.
 *
 * K is a product tuning knob: too low (1) thrashes a skill needed every
 * other turn; too high defeats the cost savings (full bodies are the
 * dominant controllable LLM cost). K=3 keeps a skill alive across a
 * short approval round-trip while still aging out idle topics.
 */
export const SKILL_FULL_BODY_RECENCY_K = 3;

/**
 * Retention horizon — DECOUPLED from the full-body demotion threshold.
 *
 * A slug that ages past `SKILL_FULL_BODY_RECENCY_K` is DEMOTED to the
 * skill INDEX (its full body stops rendering) but it MUST stay in
 * `loaded_skills` / membership so it keeps reaching the assembler's
 * "Loaded" index block — the spec's central "no skill disappears"
 * contract. This matters most for skills that live in NO scope index:
 * out-of-scope connector/workflow skills and experimental
 * (`load_skill`-only) skills. If we pruned them at the demotion
 * boundary they would vanish from the prompt entirely and the LLM could
 * not `load_skill` them back (they are referenced nowhere), and their
 * gated tools would re-lock (the palette reads membership).
 *
 * Pruning therefore fires only once a slug has sat in the index,
 * untouched, for `SKILL_RETENTION_TURNS` turns — long enough that the
 * topic is genuinely abandoned, while the loaded set stays bounded
 * (rotating topics cannot grow without bound). It is a strict multiple
 * of K so the index-visible window is always wider than the full-body
 * window.
 */
export const SKILL_RETENTION_TURNS = SKILL_FULL_BODY_RECENCY_K * 8; // 24

/**
 * Apply this turn's recency update to the loaded set and project the
 * full-body subset, the surviving array (after optional pruning), and
 * the slug membership (for the palette + index).
 *
 * - `refresh`: slugs whose `last_turn` is reset to `currentTurn` this
 *   turn (baseline ∪ re-affirmed matches).
 * - `additions`: brand-new slugs to insert at `last_turn = currentTurn`
 *   (autoload additions). Merged by slug; an addition that is already
 *   loaded just refreshes recency.
 *
 * Two DISTINCT thresholds (this is the fix for the index-safety bug):
 *   - FULL BODY: `age < SKILL_FULL_BODY_RECENCY_K` — full body renders.
 *   - MEMBERSHIP: `age < SKILL_RETENTION_TURNS` — slug survives in
 *     `next`/`membership` and reaches the "Loaded" index. Between the
 *     two thresholds a slug is index-visible but NOT full-body.
 *
 * Entries with `age >= SKILL_RETENTION_TURNS` are pruned UNLESS their
 * slug is in `neverPrune` (baseline slugs re-refresh every turn anyway,
 * but pruning one would briefly drop it from the index — keep stable).
 *
 * Pure — no DB, no mutation of the input array.
 */
export function applyRecency(
  loaded: readonly LoadedSkillEntry[],
  currentTurn: number,
  refresh: ReadonlySet<string>,
  additions: readonly string[],
  neverPrune: ReadonlySet<string>,
): {
  /** Updated array to persist (refreshed, added, pruned). */
  next: LoadedSkillEntry[];
  /** Slugs whose FULL body is rendered this turn. */
  fullBodySet: string[];
  /** All surviving slugs — drives the palette (NOT recency-filtered). */
  membership: string[];
} {
  const bySlug = new Map<string, number>();
  for (const e of loaded) {
    // Last-writer-wins on duplicate slugs (defensive — the array is
    // merge-by-slug everywhere it is written).
    bySlug.set(e.slug, refresh.has(e.slug) ? currentTurn : e.last_turn);
  }
  for (const slug of additions) bySlug.set(slug, currentTurn);

  const next: LoadedSkillEntry[] = [];
  for (const [slug, last_turn] of bySlug) {
    const age = currentTurn - last_turn;
    // Prune on the RETENTION horizon, NOT the full-body demotion
    // threshold. A slug that aged out of the full body (age >= K) is kept
    // in `next` until `age >= SKILL_RETENTION_TURNS` so it remains
    // index-visible and `load_skill`-reachable in the meantime.
    if (age >= SKILL_RETENTION_TURNS && !neverPrune.has(slug)) continue;
    next.push({ slug, last_turn });
  }

  const fullBodySet = next
    .filter((e) => currentTurn - e.last_turn < SKILL_FULL_BODY_RECENCY_K)
    .map((e) => e.slug);
  const membership = next.map((e) => e.slug);
  return { next, fullBodySet, membership };
}
