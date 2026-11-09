export type SessionResolution =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "revoked" }>
  | Readonly<{ kind: "expired_absolute"; absolute_expires_at_ms: number }>
  | Readonly<{ kind: "expired_sliding"; last_seen_at_ms: number }>
  | Readonly<{ kind: "active"; next_last_seen_at_ms: number }>;

export interface SessionResolutionFacts {
  revoked_at_ms: number | null;
  created_at_ms: number;
  last_seen_at_ms: number | null;
  absolute_expires_at_ms: number | null;
}

export function decideSessionResolution(
  session: SessionResolutionFacts | null,
  now_ms: number,
  sliding_ttl_ms: number,
  absolute_ttl_ms: number,
): SessionResolution {
  if (session === null) return { kind: "not_found" };
  if (session.revoked_at_ms !== null) return { kind: "revoked" };
  const absolute_expires_at_ms =
    session.absolute_expires_at_ms ?? session.created_at_ms + absolute_ttl_ms;
  if (absolute_expires_at_ms <= now_ms) return { kind: "expired_absolute", absolute_expires_at_ms };
  const last_seen_at_ms = session.last_seen_at_ms ?? session.created_at_ms;
  if (now_ms - last_seen_at_ms > sliding_ttl_ms)
    return { kind: "expired_sliding", last_seen_at_ms };
  return { kind: "active", next_last_seen_at_ms: now_ms };
}
