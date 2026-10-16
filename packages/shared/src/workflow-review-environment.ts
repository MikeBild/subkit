interface EffectLike {
  step_id?: string | null;
  environment?: string | null;
}

interface IssueLike {
  step_id?: string | null;
  code?: string | null;
}

export interface ReviewLike {
  eligible_for_repeated_runs?: boolean;
  manifest?: { effects?: readonly EffectLike[]; issues?: readonly IssueLike[] } | null;
}

export type ReviewEnvironment = "dev" | "prod";

const isEnvironment = (value: unknown): value is ReviewEnvironment =>
  value === "dev" || value === "prod";

export function environmentToCorrectTo(
  review: ReviewLike | null | undefined,
  current: ReviewEnvironment,
  held: readonly ReviewEnvironment[],
): ReviewEnvironment | null {
  if (!review || review.eligible_for_repeated_runs) return null;
  if (held.includes(current)) return null;
  const mismatched = new Set(
    (review.manifest?.issues ?? [])
      .filter((issue) => issue.code === "environment_mismatch")
      .map((issue) => issue.step_id)
      .filter((step): step is string => typeof step === "string"),
  );
  if (mismatched.size === 0) return null;
  const resolved = new Set<ReviewEnvironment>();
  for (const effect of review.manifest?.effects ?? []) {
    if (typeof effect.step_id !== "string" || !mismatched.has(effect.step_id)) continue;
    if (isEnvironment(effect.environment)) resolved.add(effect.environment);
    else return null;
  }
  const accounted = new Set(
    (review.manifest?.effects ?? [])
      .map((effect) => effect.step_id)
      .filter((step): step is string => typeof step === "string" && mismatched.has(step)),
  );
  if (accounted.size !== mismatched.size) return null;
  if (resolved.size !== 1) return null;
  const [only] = [...resolved];
  return only && only !== current ? only : null;
}

export function heldEnvironments(sources: {
  chosen?: ReviewEnvironment | null;
  ranIn?: ReviewEnvironment | null;
  runsIn?: readonly ReviewEnvironment[];
}): ReviewEnvironment[] {
  const held = new Set<ReviewEnvironment>(sources.runsIn ?? []);
  if (sources.chosen) held.add(sources.chosen);
  if (sources.ranIn) held.add(sources.ranIn);
  return [...held];
}
