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
  for (const authority of authorities ?? []) {
    if (isEnvironment(authority.execution_environment)) return authority.execution_environment;
  }
  if (isEnvironment(hold?.execution_mode)) return hold.execution_mode;
  return "dev";
}
