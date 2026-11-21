import { REGEX_UNSAFE } from "@shared/error-taxonomy.ts";

export const SAFE_REGEX_MAX_PATTERN = 256;
export const SAFE_REGEX_MAX_INPUT = 4096;

export type UnsafeRegexReason =
  | "pattern_too_long"
  | "nested_quantifier"
  | "alternation_under_quantifier"
  | "backreference"
  | "invalid";

export const SAFE_REGEX_REMEDY =
  "Use a simpler pattern: at most 256 characters, no quantified group that contains another quantifier or an alternation (write (ab)+ instead of (a+b)+ or (a|b)+, use a character class like [ab]+), no backreferences.";

export class UnsafeRegexError extends Error {
  readonly code = REGEX_UNSAFE;
  readonly remedy = SAFE_REGEX_REMEDY;
  constructor(
    readonly reason: UnsafeRegexReason,
    readonly pattern: string,
  ) {
    super(`${REGEX_UNSAFE}: pattern refused (${reason}). ${SAFE_REGEX_REMEDY}`);
    this.name = "UnsafeRegexError";
  }
}

export interface SafeRegex {
  readonly source: string;
  test(input: string): boolean;
}

interface Frame {
  quantified: boolean;
  alternation: boolean;
}

function quantifierAt(pattern: string, i: number): { end: number; repeats: boolean } | null {
  const ch = pattern[i];
  if (ch === "*" || ch === "+") return { end: i + 1, repeats: true };
  if (ch === "?") return { end: i + 1, repeats: false };
  if (ch !== "{") return null;
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
  if (!match) return null;
  const max = match[2] === undefined ? Number(match[1]) : match[3] ? Number(match[3]) : Infinity;
  return { end: i + match[0].length, repeats: max > 1 };
}

function skipLazy(pattern: string, i: number): number {
  return pattern[i] === "?" || pattern[i] === "+" ? i + 1 : i;
}

function skipClass(pattern: string, i: number): number {
  let j = i + 1;
  if (pattern[j] === "^") j += 1;
  if (pattern[j] === "]") j += 1;
  while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
  return j + 1;
}

export function unsafeRegexReason(pattern: string): UnsafeRegexReason | null {
  if (pattern.length > SAFE_REGEX_MAX_PATTERN) return "pattern_too_long";
  const stack: Frame[] = [{ quantified: false, alternation: false }];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    let atomEnd: number;
    let group: Frame | null = null;
    if (ch === "\\") {
      if (/[1-9k]/.test(pattern[i + 1] ?? "")) return "backreference";
      atomEnd = i + 2;
    } else if (ch === "[") {
      atomEnd = skipClass(pattern, i);
    } else if (ch === "(") {
      stack.push({ quantified: false, alternation: false });
      i += 1;
      if (pattern[i] === "?") {
        i += 1;
        if (pattern[i] === "<" && pattern[i + 1] !== "=" && pattern[i + 1] !== "!") {
          const close = pattern.indexOf(">", i);
          i = close === -1 ? pattern.length : close + 1;
        } else if (pattern[i] === "<") i += 2;
        else i += 1;
      }
      continue;
    } else if (ch === ")") {
      group = stack.pop() ?? { quantified: false, alternation: false };
      if (stack.length === 0) return "invalid";
      atomEnd = i + 1;
    } else if (ch === "|") {
      const top = stack[stack.length - 1] as Frame;
      top.alternation = true;
      i += 1;
      continue;
    } else {
      atomEnd = i + 1;
    }
    const quantifier = quantifierAt(pattern, atomEnd);
    const top = stack[stack.length - 1] as Frame;
    if (group) {
      if (quantifier?.repeats) {
        if (group.quantified) return "nested_quantifier";
        if (group.alternation) return "alternation_under_quantifier";
      }
      top.quantified ||= group.quantified || quantifier?.repeats === true;
      top.alternation ||= group.alternation;
    } else if (quantifier?.repeats) {
      top.quantified = true;
    }
    i = quantifier ? skipLazy(pattern, quantifier.end) : atomEnd;
  }
  return stack.length === 1 ? null : "invalid";
}

export function safeRegex(pattern: string, flags = ""): SafeRegex {
  const reason = unsafeRegexReason(pattern);
  if (reason) throw new UnsafeRegexError(reason, pattern);
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, flags.replace(/[gy]/g, ""));
  } catch {
    throw new UnsafeRegexError("invalid", pattern);
  }
  return {
    source: pattern,
    test: (input) => compiled.test(input.slice(0, SAFE_REGEX_MAX_INPUT)),
  };
}

export function isSafeRegex(pattern: string): boolean {
  if (unsafeRegexReason(pattern) !== null) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
