// The review already knows which half of the installation these steps live in.
//
// The dialog picks an environment before it can see anything: the newest live
// approval's, else a held schedule's, else development. A called child has
// neither — no approval of its own, no schedule — so it fell to development,
// every connector-bound step came back `environment_mismatch`, and the reader
// was told "SubKit cannot yet check the permitted actions of this workflow,
// investigate the cause in the chat". Switching the dropdown to production
// turned the same version fully bindable.
//
// Nothing had to be investigated. The answer was in the response that carried
// the complaint: each effect names the environment its connector really
// belongs to, whichever environment was asked about. This reads it back.

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

/**
 * The environment this review should have been asked about, or null to leave
 * the choice alone.
 *
 * Answers only the unambiguous case: the review refused, it refused BECAUSE of
 * the environment, and every step that complained resolves to the same other
 * half. A workflow whose steps genuinely straddle both halves gets null — the
 * issue list already names each step, and silently picking one half would hide
 * half the problem behind a correct-looking screen.
 */
export function environmentToCorrectTo(
  review: ReviewLike | null | undefined,
  current: ReviewEnvironment,
): ReviewEnvironment | null {
  if (!review || review.eligible_for_repeated_runs) return null;
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
    // An effect that does not name an environment cannot vote, and its step
    // stays unaccounted for below.
    if (isEnvironment(effect.environment)) resolved.add(effect.environment);
    else return null;
  }
  // Every complaining step has to be accounted for. A step that complained and
  // produced no effect is a reason this review refused that switching will not
  // fix, so leave the reader where they are.
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
