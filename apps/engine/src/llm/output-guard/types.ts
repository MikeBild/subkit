export interface Violation {
  kind: string;
  message: string;
  span?: { start: number; end: number };
  details?: Record<string, unknown>;
  repair?: string;
}

export interface ScannerContext {
  engine_url?: string;
  tenant_slug?: string;
}

export interface Scanner {
  readonly id: string;
  scan(text: string, ctx: ScannerContext): Violation[];
}

export type GuardMode = "soft" | "hard" | "off";

export interface GuardResult {
  text: string;
  violations: Violation[];
  mode: GuardMode;
  duration_ms: number;
}
