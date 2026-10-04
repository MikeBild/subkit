import { getConfig } from "../../config/loader.ts";
import { findSecretSpans } from "../../logging/scrub-secrets.ts";
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
import { stripLeakedToolCallMarkup } from "./strip-tool-call-markup.ts";
import type { GuardMode, GuardResult, Scanner, ScannerContext, Violation } from "./types.ts";

export type { GuardMode, GuardResult, Scanner, ScannerContext, Violation };

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

type SpannedViolation = Violation & { span: NonNullable<Violation["span"]> };

function selectRewriteSpans(vs: Violation[]): SpannedViolation[] {
  const spanned: SpannedViolation[] = vs.filter((v): v is SpannedViolation => v.span !== undefined);
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
  for (const v of selectRewriteSpans(violations)) {
    const { start, end } = v.span;
    if (v.repair !== undefined) {
      out = `${out.slice(0, start)}${v.repair}${out.slice(end)}`;
      continue;
    }
    if (v.kind === "tool.phantom_reference") {
      const token = (v.details as { invented_tool?: unknown } | undefined)?.invented_tool;
      if (typeof token === "string") {
        out = `${out.slice(0, start)}${token}${out.slice(end)}`;
        continue;
      }
    }
    const before = out.slice(0, start);
    let after = out.slice(end);
    if (before.endsWith(" ") && after.startsWith(" ")) {
      after = after.replace(/^\s+/, "");
    }
    out = `${before}${after}`;
  }
  return out;
}

export interface RunGuardOptions {
  mode?: GuardMode;
  scanners?: ReadonlyArray<Scanner>;
}

export function runOutputGuard(
  text: string,
  ctx: ScannerContext,
  opts: RunGuardOptions = {},
): GuardResult {
  const mode = effectiveMode(opts.mode);
  const scanners = opts.scanners ?? DEFAULT_SCANNERS;
  const startedAt = Date.now();

  let scanText = text;
  const secretSpans = findSecretSpans(scanText);
  for (const s of [...secretSpans].sort((a, b) => b.start - a.start)) {
    scanText = `${scanText.slice(0, s.start)}***REDACTED:${s.kind}***${scanText.slice(s.end)}`;
  }
  for (const s of secretSpans) {
    recordLlmOutputViolation({ kind: `secret.${s.kind}`, mode });
  }

  const toolStrip = stripLeakedToolCallMarkup(scanText);
  if (toolStrip.stripped > 0) {
    scanText = toolStrip.text;
    for (let i = 0; i < toolStrip.stripped; i++) {
      recordLlmOutputViolation({ kind: "tool.leaked_markup", mode });
    }
  }

  if (mode === "off") {
    return { text: scanText, violations: [], mode, duration_ms: 0 };
  }

  const violations: Violation[] = [];
  for (const s of scanners) {
    try {
      violations.push(...s.scan(scanText, ctx));
    } catch {
      recordLlmOutputViolation({ kind: `scanner.${s.id}.threw`, mode });
    }
  }

  const duration_ms = Date.now() - startedAt;
  recordLlmOutputGuardDuration(duration_ms);
  for (const v of violations) {
    recordLlmOutputViolation({ kind: v.kind, mode });
  }

  if (violations.length === 0) {
    return { text: scanText, violations, mode, duration_ms };
  }

  if (mode === "hard") {
    throw new LlmOutputViolation(violations);
  }

  const rewritten = rewriteSoft(scanText, violations);
  return { text: rewritten, violations, mode, duration_ms };
}

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
        break;
      }
    } catch {}
  }
  for (const v of violations) {
    recordLlmOutputViolation({ kind: `${v.kind}.streamed`, mode });
  }
  return violations;
}
