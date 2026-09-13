// One rule for "may this credential still authenticate?", shared by every
// path that answers the question.
//
// Before tranche E the repository held two different answers: the API-key
// resolver refused a soft-deleted or disabled owner, while the MCP-OAuth
// resolver matched only on id + tenant — so a deactivated person's OAuth
// token kept working, and the refresh rotation read no user row at all.
// The rule is not "OAuth is special"; it is the one below, and both the
// access path and the refresh path apply it.
//
// A credential is only as live as the identity behind it and the client
// registration it was issued to. Everything else (revocation, expiry,
// rotation) is a property of the token row itself and stays where it is.

/** The columns a liveness decision needs — nothing else is read. */
export interface UserLivenessRow {
  status: string;
  deleted_at: Date | null;
}

/** The columns a client-registration decision needs. */
export interface ClientLivenessRow {
  disabled_at: Date | null;
}

export type LivenessRefusal =
  "user_missing" | "user_deleted" | "user_disabled" | "client_missing" | "client_revoked";

/**
 * `null` when the person may still authenticate. Disabling or soft-deleting
 * a user must void their credentials at once — a still-valid token for a
 * withdrawn account is exactly what an operator expects withdrawal to prevent.
 */
export function userLivenessRefusal(user: UserLivenessRow | undefined): LivenessRefusal | null {
  if (!user) return "user_missing";
  if (user.deleted_at !== null) return "user_deleted";
  if (user.status !== "active") return "user_disabled";
  return null;
}

/** `null` when the client registration may still be used. */
export function clientLivenessRefusal(
  client: ClientLivenessRow | undefined,
): LivenessRefusal | null {
  if (!client) return "client_missing";
  if (client.disabled_at !== null) return "client_revoked";
  return null;
}

/**
 * What the refusal says out loud on the token endpoint. It names what
 * happened; it never advises pasting an API key, which is the fallback
 * tranche B removed from the connection story.
 */
export function livenessRefusalDescription(refusal: LivenessRefusal): string {
  switch (refusal) {
    case "user_missing":
    case "user_deleted":
    case "user_disabled":
      return "the person who approved this connection is no longer active in this installation — an administrator has to restore the account, or someone else has to approve the connection again";
    case "client_missing":
    case "client_revoked":
      return "the client registration behind this connection was revoked — the client has to register and be approved again";
  }
}
