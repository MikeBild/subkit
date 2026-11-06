interface UserLivenessRow {
  status: string;
  deleted_at: Date | null;
}

interface ClientLivenessRow {
  disabled_at: Date | null;
  retired_at: Date | null;
}

export type LivenessRefusal =
  | "user_missing"
  | "user_deleted"
  | "user_disabled"
  | "client_missing"
  | "client_revoked"
  | "client_retired";

export function userLivenessRefusal(user: UserLivenessRow | undefined): LivenessRefusal | null {
  if (!user) return "user_missing";
  if (user.deleted_at !== null) return "user_deleted";
  if (user.status !== "active") return "user_disabled";
  return null;
}

export function clientLivenessRefusal(
  client: ClientLivenessRow | undefined,
): LivenessRefusal | null {
  if (!client) return "client_missing";
  if (client.disabled_at !== null)
    return client.retired_at !== null ? "client_retired" : "client_revoked";
  return null;
}

export function livenessRefusalDescription(refusal: LivenessRefusal): string {
  switch (refusal) {
    case "user_missing":
    case "user_deleted":
    case "user_disabled":
      return "the person who approved this connection is no longer active in this installation — an administrator has to restore the account, or someone else has to approve the connection again";
    case "client_missing":
    case "client_revoked":
      return "the client registration behind this connection was revoked — the client has to register and be approved again";
    case "client_retired":
      return "the client registration behind this connection was retired after a week without a valid approval or any use — approving it again brings it back";
  }
}
