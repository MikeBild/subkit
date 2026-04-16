// Types shared across inbound verifiers.

export interface VerifyInput {
  headers: Record<string, string>;
  rawBody: string;
  secret: string;
  /** Optional clock override for tests. Unix ms. */
  now?: number;
  /** Optional per-binding config blob (GitHub/Stripe options). */
  config?: Record<string, unknown> | null | undefined;
}

export interface NormalizedEvent {
  /** Opaque unique id used for replay-dedup. */
  id: string;
  /** Unix seconds. */
  timestamp: number;
  /** Provider-native event type, e.g. "push", "invoice.paid". */
  type: string;
}

export type VerifierResult =
  | { ok: true; normalized: NormalizedEvent }
  | { ok: false; reason: string };

export type VerifierFn = (input: VerifyInput) => VerifierResult;
