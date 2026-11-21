export interface IdlePolicy {
  readonly min_idle_s: number;
  readonly max_wait_ms: number;
  readonly poll_ms: number;
}

export const OWNER_IDLE: IdlePolicy = { min_idle_s: 1, max_wait_ms: 15_000, poll_ms: 250 };

export type IdleStep =
  | { readonly kind: "act" }
  | { readonly kind: "wait"; readonly wait_ms: number }
  | { readonly kind: "owner_active" };

export function idleStep(
  idleSeconds: number | null,
  waitedMs: number,
  policy: IdlePolicy = OWNER_IDLE,
): IdleStep {
  const idle = Number.isFinite(idleSeconds) ? (idleSeconds as number) : 0;
  if (idle >= policy.min_idle_s) return { kind: "act" };
  const remaining = policy.max_wait_ms - waitedMs;
  if (remaining <= 0) return { kind: "owner_active" };
  const needed = Math.ceil((policy.min_idle_s - idle) * 1000);
  return { kind: "wait", wait_ms: Math.min(Math.max(needed, policy.poll_ms), remaining) };
}
