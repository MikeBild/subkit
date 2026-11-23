import type { AuthorityRefusalCode } from "@shared/authority-refusal.ts";

export type AuthorityAvailability =
  | "live"
  | "expired"
  | "exhausted"
  | "revoked"
  | "boundary_changed"
  | "version_changed"
  | "none";

export interface AuthorityAvailabilityRow {
  readonly revoked_at: Date | null;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
  readonly max_runs: number | null;
  readonly reserved_runs: number;
  readonly workflow_version_id: string;
  readonly effect_manifest_digest: string;
}

export interface AuthorityAvailabilityFacts {
  readonly authority: AuthorityAvailabilityRow | null;
  readonly now: Date;
  readonly use: "reserve" | "reserved";
  readonly current_version_id?: string | null;
  readonly boundary_digest?: string | null;
}

export function decideAuthorityAvailability(
  facts: AuthorityAvailabilityFacts,
): AuthorityAvailability {
  const { authority, now } = facts;
  if (!authority) return "none";
  if (authority.revoked_at !== null) return "revoked";
  if (
    facts.current_version_id !== undefined &&
    authority.workflow_version_id !== facts.current_version_id
  )
    return "version_changed";
  if (authority.valid_until !== null && authority.valid_until.getTime() <= now.getTime())
    return "expired";
  if (
    facts.use === "reserve" &&
    authority.max_runs !== null &&
    authority.reserved_runs >= authority.max_runs
  )
    return "exhausted";
  if (authority.valid_from.getTime() > now.getTime()) return "none";
  if (facts.use === "reserved" && authority.reserved_runs <= 0) return "none";
  if (
    facts.boundary_digest !== undefined &&
    authority.effect_manifest_digest !== facts.boundary_digest
  )
    return "boundary_changed";
  return "live";
}

const REFUSALS: Readonly<
  Record<Exclude<AuthorityAvailability, "live">, { code: AuthorityRefusalCode; message: string }>
> = {
  expired: {
    code: "execution_authority_expired",
    message: "the execution authority has expired",
  },
  exhausted: {
    code: "execution_authority_exhausted",
    message: "the execution authority has no runs remaining",
  },
  revoked: {
    code: "execution_authority_revoked",
    message: "the execution authority was revoked",
  },
  boundary_changed: {
    code: "execution_authority_changed",
    message: "the execution authority no longer matches the current effect boundary",
  },
  version_changed: {
    code: "execution_authority_required",
    message: "no execution authority covers the active workflow version",
  },
  none: {
    code: "execution_authority_required",
    message: "no execution authority covers this workflow",
  },
};

export function authorityRefusal(availability: Exclude<AuthorityAvailability, "live">): {
  code: AuthorityRefusalCode;
  message: string;
} {
  return REFUSALS[availability];
}

export interface AuthorityCandidate extends AuthorityAvailabilityRow {
  readonly superseded: boolean;
}

export function selectAuthority<T extends AuthorityCandidate>(
  newestFirst: readonly T[],
  facts: Omit<AuthorityAvailabilityFacts, "authority">,
): { authority: T | null; availability: AuthorityAvailability } {
  const judged = newestFirst.map((authority) => ({
    authority,
    availability: decideAuthorityAvailability({ ...facts, authority }),
  }));
  const live = judged.find((entry) => entry.availability === "live");
  if (live) return live;
  const standing = judged.filter((entry) => !entry.authority.superseded);
  const explained =
    standing.find((entry) => entry.authority.workflow_version_id === facts.current_version_id) ??
    standing[0] ??
    judged[0];
  return explained ?? { authority: null, availability: "none" };
}

export function lastUnavailable(
  seen: readonly AuthorityAvailability[],
): Exclude<AuthorityAvailability, "live"> {
  for (let index = seen.length - 1; index >= 0; index--) {
    const availability = seen[index];
    if (availability !== undefined && availability !== "live") return availability;
  }
  return "none";
}
