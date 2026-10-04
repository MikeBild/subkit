export interface VerifyInput {
  headers: Record<string, string>;
  rawBody: string;
  secret: string;
  now?: number;
  config?: Record<string, unknown> | null | undefined;
}

export interface NormalizedEvent {
  id: string;
  timestamp: number;
  type: string;
}

export type VerifierResult =
  | { ok: true; normalized: NormalizedEvent }
  | { ok: false; reason: string };

export type VerifierFn = (input: VerifyInput) => VerifierResult;
