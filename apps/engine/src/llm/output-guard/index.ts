// llmOutputGuard — the orchestrator.
//
// Composes scanners (declared order matters — first violation wins
// in soft-mode rewrite, but every scanner still runs so analytics
// see the full picture). Honours `LLM_OUTPUT_GUARD`:
//   - `soft`: rewrites violating spans with `[guard:<kind>]` markers
//             and continues. Logs every violation to observability.
//   - `hard`: throws `LlmOutputViolation` on the first non-empty
//             violation list. Used in CI / scenario tests.
//   - `off`:  bypass entirely.
//
// The hook point is `apps/engine/src/conversations/loop.ts`'s
// `onStepFinish` (where the assistant text is captured per step).

import { getConfig } from "../../config/loader.ts";
import {
  recordLlmOutputGuardDuration,
  recordLlmOutputViolation,
} from "../../observability/instrumentation.ts";
import { LlmOutputViolation } from "../errors.ts";
import { chatFirstScanner } from "./scanners/chat-first.ts";
import { cliScanner } from "./scanners/cli.ts";
import { placeholderScanner } from "./scanners/placeholder.ts";
import { toolScanner } from "./scanners/tool.ts";
import { urlScanner } from "./scanners/url.ts";
import { vendorRecipeScanner } from "./scanners/vendor-recipe.ts";
import type { GuardMode, GuardResult, Scanner, ScannerContext, Violation } from "./types.ts";

export type { GuardMode, GuardResult, Scanner, ScannerContext, Violation };

/**
 * Default scanner roster. Order is significant: the first scanner
 * whose violation overlaps a span "owns" the soft-mode rewrite for
 * that span, but every scanner still runs for analytics and tests.
 * Add new scanners (cli, tool, vendor_recipe, jsonata) in later
 * deliverables — keep this export stable so callers can compose.
 */
export const DEFAULT_SCANNERS: ReadonlyArray<Scanner> = [
  placeholderScanner,
  urlScanner,
  vendorRecipeScanner,
  cliScanner,
  toolScanner,
  chatFirstScanner,
];

function effectiveMode(override?: GuardMode): GuardMode {
  if (override) return override;
  try {
    return getConfig().llm.output_guard;
  } catch {
    return "soft";
  }
}

/**
 * De-overlap violations: prefer narrower (more specific) spans when two
 * overlap, then sort the survivors descending by start so we can splice
 * without shifting indexes.
 *
 * Rationale: a placeholder.host violation on `your-subkit-instance.com`
 * is strictly more informative than the broader url.unknown_origin
 * violation on the surrounding `https://…/mcp` URL. The narrower one
 * wins; the broader one is dropped from the rewrite (but still recorded
 * as a violation in observability).
 */
type SpannedViolation = Violation & { span: NonNullable<Violation["span"]> };

function selectRewriteSpans(vs: Violation[]): SpannedViolation[] {
  const spanned: SpannedViolation[] = vs.filter((v): v is SpannedViolation => v.span !== undefined);
  // Narrowest first (smallest span length).
  const byNarrowest = spanned
    .slice()
    .sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start));
  const accepted: SpannedViolation[] = [];
  for (const v of byNarrowest) {
    const overlaps = accepted.some((a) => v.span.start < a.span.end && a.span.start < v.span.end);
    if (!overlaps) accepted.push(v);
  }
  return accepted.sort((a, b) => b.span.start - a.span.start);
}

function rewriteSoft(text: string, violations: Violation[]): string {
  let out = text;
  // When a violation carries a `repair`, splice that in — the scanner
  // knew the grounded value (e.g. engine_url's host) and produced a
  // usable substitute. Otherwise the offending span is removed
  // entirely (collapsing any trailing whitespace so sentence flow
  // survives). The original fragment is preserved in
  // `violation.details.match` and the violation record itself is
  // surfaced on `GuardResult.violations` so the caller can show it in
  // a dedicated diagnostic surface and feed it back into the next
  // turn's system context — that replaces the old `[guard:<kind>]`
  // marker that used to leak into the user-visible chat transcript.
  for (const v of selectRewriteSpans(violations)) {
    const { start, end } = v.span;
    if (v.repair !== undefined) {
      out = `${out.slice(0, start)}${v.repair}${out.slice(end)}`;
      continue;
    }
    // tool.phantom_reference with no repair: strip just the backticks
    // around the token rather than deleting the span. A true positive
    // ("I'll call `create_oauth_app`") then stays grammatical
    // ("I'll call create_oauth_app") instead of collapsing into
    // "I'll call ." — the offending bare token is still surfaced on
    // `GuardResult.violations` and fed back into the next turn.
    if (v.kind === "tool.phantom_reference") {
      const token = (v.details as { invented_tool?: unknown } | undefined)?.invented_tool;
      if (typeof token === "string") {
        out = `${out.slice(0, start)}${token}${out.slice(end)}`;
        continue;
      }
    }
    const before = out.slice(0, start);
    let after = out.slice(end);
    // Swallow any leading space/tab so "foo `phantom_reference` bar"
    // becomes "foo bar" instead of "foo  bar".
    if (before.endsWith(" ") && after.startsWith(" ")) {
      after = after.replace(/^\s+/, "");
    }
    out = `${before}${after}`;
  }
  return out;
}

export interface RunGuardOptions {
  /** Override the env-derived mode (used by tests + scenario runners). */
  mode?: GuardMode;
  /** Override the scanner roster (used by per-flow filters). */
  scanners?: ReadonlyArray<Scanner>;
}

/**
 * Run every scanner against the assistant text and apply the
 * mode-specific reaction. Always emits the violations + duration to
 * observability before deciding what to do.
 */
export function runOutputGuard(
  text: string,
  ctx: ScannerContext,
  opts: RunGuardOptions = {},
): GuardResult {
  const mode = effectiveMode(opts.mode);
  const scanners = opts.scanners ?? DEFAULT_SCANNERS;
  const startedAt = Date.now();
  if (mode === "off") {
    return { text, violations: [], mode, duration_ms: 0 };
  }

  const violations: Violation[] = [];
  for (const s of scanners) {
    try {
      violations.push(...s.scan(text, ctx));
    } catch {
      // A faulty scanner must never crash the LLM loop — record and continue.
      recordLlmOutputViolation({ kind: `scanner.${s.id}.threw`, mode });
    }
  }

  const duration_ms = Date.now() - startedAt;
  recordLlmOutputGuardDuration(duration_ms);
  for (const v of violations) {
    recordLlmOutputViolation({ kind: v.kind, mode });
  }

  if (violations.length === 0) {
    return { text, violations, mode, duration_ms };
  }

  if (mode === "hard") {
    throw new LlmOutputViolation(violations);
  }

  // soft: rewrite the offending spans with a marker so the user sees
  // *something* explaining the gap, and the model sees on the next
  // turn that the placeholder did not survive.
  const rewritten = rewriteSoft(text, violations);
  return { text: rewritten, violations, mode, duration_ms };
}

/**
 * Streaming companion to `runOutputGuard` — invoked at paragraph
 * boundaries during the textStream drain. Logs violations early so
 * operators see them before the step finishes; does NOT rewrite (that
 * still happens in the `onStepFinish` batch pass with the full text).
 *
 * The contract is intentionally weaker than the batch path: scanners
 * may produce false positives near chunk boundaries (e.g. a placeholder
 * split across two paragraph buffers), so we only emit telemetry
 * markers and never throw, even in `hard` mode. The authoritative
 * decision is the batch pass.
 *
 * Short-circuits scanner execution on the FIRST scanner that finds a
 * violation — later scanners do not run. Their findings would be
 * redundant given the early-warning contract (the operator only needs
 * to see "something is wrong with this paragraph" once), and the
 * authoritative full-text pass at `onStepFinish` still runs every
 * scanner against the complete step output.
 */
export function runOutputGuardStream(
  paragraphText: string,
  ctx: ScannerContext,
  opts: RunGuardOptions = {},
): Violation[] {
  const mode = effectiveMode(opts.mode);
  if (mode === "off" || paragraphText.length === 0) return [];
  const scanners = opts.scanners ?? DEFAULT_SCANNERS;
  const violations: Violation[] = [];
  for (const s of scanners) {
    try {
      const found = s.scan(paragraphText, ctx);
      if (found.length > 0) {
        violations.push(...found);
        // Short-circuit: subsequent scanners are skipped for this
        // paragraph. The full-text batch pass on step finish still
        // runs every scanner — that pass owns the rewrite decision.
        break;
      }
    } catch {
      // Faulty scanner must not crash the stream drain.
    }
  }
  for (const v of violations) {
    recordLlmOutputViolation({ kind: `${v.kind}.streamed`, mode });
  }
  return violations;
}
