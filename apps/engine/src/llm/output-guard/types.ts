// llmOutputGuard — shared types.
//
// One Violation describes a single grounding failure detected by a
// scanner: a placeholder host, an invented CLI flag, a phantom tool
// reference, etc. ScannerContext carries everything a scanner needs
// to make its judgement: the runtime manifests (engine_url, tool
// registry, vendor recipes) plus per-turn metadata. Every scanner is
// pure — it receives the text + context and returns 0..N violations
// without side effects, so they compose freely and stay testable.

export interface Violation {
  /**
   * Stable scanner kind, dot-separated. Examples:
   * `placeholder.host`, `placeholder.key_template`, `url.unknown_origin`,
   * `cli.invented_flag`, `tool.phantom_reference`,
   * `vendor_recipe.unverified`, `jsonata.invented_path`.
   */
  kind: string;
  /** Operator-friendly explanation. Rendered in dashboards verbatim. */
  message: string;
  /** Span (`[start, end)`) within the scanned text that triggered the rule. */
  span?: { start: number; end: number };
  /** Free-form payload — names of placeholders matched, suggested replacements, etc. */
  details?: Record<string, unknown>;
}

export interface ScannerContext {
  /**
   * Real engine origin for this turn — when present, scanners can
   * compare against any URL emitted by the assistant. Absent for
   * background flows (`generate`, `repair`) that have no inbound
   * request URL.
   */
  engine_url?: string;
  /** Tenant slug, surfaced for diagnostic messages. */
  tenant_slug?: string;
}

export interface Scanner {
  /** Stable id used in logs + tests; must match the prefix of the kinds it emits. */
  readonly id: string;
  scan(text: string, ctx: ScannerContext): Violation[];
}

export type GuardMode = "soft" | "hard" | "off";

export interface GuardResult {
  /** Possibly rewritten text. In `soft` mode, offending fragments are wrapped with a marker; in `hard` mode the original is returned and the orchestrator throws. */
  text: string;
  /** Every violation found by every scanner. Empty when the text is clean. */
  violations: Violation[];
  /** Effective mode the orchestrator ran under. */
  mode: GuardMode;
  /** Total scan wall-clock duration in ms. */
  duration_ms: number;
}
