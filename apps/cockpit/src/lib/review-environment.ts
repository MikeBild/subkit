// Which environment a review should judge.
//
// The approval dialog decided this from whether a schedule happened to be
// held: held-and-prod meant production, anything else meant development. For a
// workflow that runs in production and is NOT currently held — the ordinary
// case for something already approved — that is the wrong half of the
// installation, so every step resolves to a connector that does not exist
// there and the dialog fills with "this step resolves to a connector of
// another environment".
//
// Observed on a production workflow: nearly every step reported that, and all
// of it was an artefact. Judged against production, exactly one real problem
// remained. A reviewer reading the first version would have concluded the
// workflow was broken beyond repair, or — worse — learned to ignore the list.
//
// What the workflow actually runs in is already known: its live approval says
// so, and so does a held schedule. Ask those, in that order, before falling
// back to development.

export type ReviewEnvironment = "dev" | "prod";

interface AuthorityLike {
  execution_environment?: string | null;
  revoked_at?: string | null;
  valid_until?: string | null;
}

interface HoldLike {
  execution_mode?: string | null;
}

const isEnvironment = (value: unknown): value is ReviewEnvironment =>
  value === "dev" || value === "prod";

/**
 * The environment to preview in: the newest still-live approval's, else a held
 * schedule's, else development.
 *
 * "Live" means not revoked and not expired — an approval that lapsed last
 * month still tells you where this workflow belongs, but a current one is the
 * better answer, so the list is consulted in the order it arrives (newest
 * first) and the first live entry wins.
 */
export function reviewEnvironment(
  authorities: readonly AuthorityLike[] | undefined,
  hold: HoldLike | undefined,
  now: Date = new Date(),
): ReviewEnvironment {
  for (const authority of authorities ?? []) {
    if (!isEnvironment(authority.execution_environment)) continue;
    if (authority.revoked_at) continue;
    if (authority.valid_until && Date.parse(authority.valid_until) <= now.getTime()) continue;
    return authority.execution_environment;
  }
  // No live approval: a lapsed one still names the half of the installation
  // this workflow belongs to, which beats guessing development.
  for (const authority of authorities ?? []) {
    if (isEnvironment(authority.execution_environment)) return authority.execution_environment;
  }
  if (isEnvironment(hold?.execution_mode)) return hold.execution_mode;
  return "dev";
}
