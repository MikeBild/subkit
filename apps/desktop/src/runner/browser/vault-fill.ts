import { normalizeOrigin } from "@shared/local-policy/addresses.ts";
import { DEFAULT_REDACTED, redactKnownValues, scrubString } from "@shared/redaction.ts";
import { z } from "zod";
import { sha256Hex } from "../../shared/local/browser-rules.ts";

export const VAULT_MARK = "data-subkit-vault";

export const DOCUMENT_PROBE_SCRIPT = `JSON.stringify((() => {
  const items = [];
  const visit = (root, depth) => {
    if (depth > 8 || items.length >= 2000) return;
    for (const el of root.querySelectorAll("*")) {
      if (items.length >= 2000) return;
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      const tag = el.tagName;
      if (!["INPUT", "SELECT", "TEXTAREA", "BUTTON", "IFRAME", "FRAME", "FORM"].includes(tag)) continue;
      if (tag !== "FORM" && el.getClientRects().length === 0) continue;
      const attr = (name) => (el.getAttribute(name) || "").toLowerCase().slice(0, 64);
      if (tag === "IFRAME" || tag === "FRAME") {
        let inner = null;
        try { inner = el.contentDocument; } catch (error) { inner = null; }
        let src = "";
        try { src = new URL(el.getAttribute("src") || "about:blank", root.baseURI || document.baseURI).origin; } catch (error) { src = ""; }
        items.push([tag, src, attr("name"), "", ""]);
        if (inner) visit(inner, depth + 1);
        continue;
      }
      items.push([tag, attr("type"), attr("name"), attr("autocomplete"), attr("id")]);
    }
  };
  visit(document, 0);
  return { page: location.origin + location.pathname, time_origin: performance.timeOrigin, structure: items };
})())`;

export const FRAME_PROBE_SCRIPT = `JSON.stringify((() => {
  const mark = (el) => { try { el.setAttribute("${VAULT_MARK}", "1"); } catch (error) {} };
  let doc = document;
  let origin = location.origin;
  let el = document.activeElement;
  for (let hops = 0; el && hops < 16; hops += 1) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") break;
    let inner = null;
    try { inner = el.contentDocument; } catch (error) { inner = null; }
    if (!inner) {
      let src = null;
      try { src = new URL(el.getAttribute("src") || "about:blank", doc.baseURI).origin; } catch (error) { src = null; }
      mark(el);
      return { origin: src, cross_origin: true, tag: null, type: null };
    }
    try { origin = inner.defaultView.location.origin; } catch (error) { return { origin: null, cross_origin: true, tag: null, type: null }; }
    doc = inner;
    el = inner.activeElement;
  }
  if (!el || el === doc.body || el === doc.documentElement) return { origin: null, cross_origin: false, tag: null, type: null };
  mark(el);
  return { origin, cross_origin: false, tag: el.tagName, type: (el.getAttribute("type") || "").toLowerCase() };
})())`;

export const TOTAL_PROBE_SCRIPT = `JSON.stringify((() => {
  const words = /(total|gesamt|summe|zu zahlen|betrag|amount due|to pay|endbetrag)/i;
  const texts = [];
  if (!document.body) return { texts };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && texts.length < 40; node = walker.nextNode()) {
    if (!words.test(node.textContent || "")) continue;
    const host = node.parentElement;
    if (!host || host.getClientRects().length === 0) continue;
    const box = host.closest("tr, li, dl, p, div, section") || host;
    texts.push((box.innerText || host.innerText || "").slice(0, 300));
  }
  return { texts };
})())`;

export const RUNNER_SCRIPTS: ReadonlySet<string> = new Set([
  DOCUMENT_PROBE_SCRIPT,
  FRAME_PROBE_SCRIPT,
  TOTAL_PROBE_SCRIPT,
]);

export const SCRIPT_TOOLS: ReadonlySet<string> = new Set([
  "agent_browser_eval",
  "agent_browser_wait_for_function",
  "agent_browser_flow_run",
  "agent_browser_webmcp_invoke",
]);

export interface ScriptLedger {
  ran(partition: string): boolean;
  mark(partition: string): void;
  reset(partition: string): void;
}

export function createScriptLedger(): ScriptLedger {
  const scripted = new Set<string>();
  return {
    ran: (partition) => scripted.has(partition),
    mark: (partition) => {
      scripted.add(partition);
    },
    reset: (partition) => {
      scripted.delete(partition);
    },
  };
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsedFrom<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  for (const candidate of [decoded(data), decoded(record.result), decoded(record.value)]) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

const DocumentProbeSchema = z.object({
  page: z.string().max(8192),
  time_origin: z.number(),
  structure: z.array(z.array(z.string().max(256)).max(8)).max(2000),
});

export function documentId(data: unknown): string | null {
  const probe = parsedFrom(DocumentProbeSchema, data);
  if (probe === null) return null;
  return `doc_${sha256Hex(JSON.stringify([probe.page, probe.structure, probe.time_origin]))}`;
}

export interface RefFacts {
  readonly role: string | null;
  readonly name: string | null;
}

const REF_LINE = /^\s*-\s*([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*[[ ,]ref=(e[0-9]+)[\],]/u;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bag(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function refFacts(data: unknown): Record<string, RefFacts> {
  const top = bag(data);
  const inner = typeof top.snapshot === "string" ? { snapshot: top.snapshot } : bag(top.snapshot);
  const source = text(inner.snapshot) !== null ? inner : top;
  const facts: Record<string, RefFacts> = {};
  for (const line of (text(source.snapshot) ?? "").split("\n")) {
    const found = REF_LINE.exec(line);
    if (found) facts[found[3] as string] = { role: found[1] as string, name: text(found[2]) };
  }
  for (const [key, value] of Object.entries(bag(source.refs))) {
    const ref = key.startsWith("@") ? key.slice(1) : key;
    const entry = bag(value);
    facts[ref] = {
      role: text(entry.role) ?? facts[ref]?.role ?? null,
      name: text(entry.name) ?? facts[ref]?.name ?? null,
    };
  }
  return facts;
}

const FrameProbeSchema = z.object({
  origin: z.string().max(2048).nullable(),
  cross_origin: z.boolean(),
  tag: z.string().max(32).nullable(),
  type: z.string().max(64).nullable(),
});
export type FrameProbe = z.infer<typeof FrameProbeSchema>;

export function frameProbe(data: unknown): FrameProbe | null {
  return parsedFrom(FrameProbeSchema, data);
}

export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = normalizeOrigin(a);
  const right = normalizeOrigin(b);
  return left !== null && right !== null && left.origin === right.origin;
}

const TotalProbeSchema = z.object({ texts: z.array(z.string().max(1000)).max(40) });

const AMOUNT = /\d{1,3}(?:[.,'   ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

export function minorUnits(text: string, exponent: number): number | null {
  const decimal = /[.,](\d{1,2})$/.exec(text);
  const whole = (decimal ? text.slice(0, decimal.index) : text).replace(/[.,'   ]/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const fraction = (decimal?.[1] ?? "").padEnd(exponent, "0");
  if (fraction.length > exponent) return null;
  const value = Number(whole) * 10 ** exponent + (fraction === "" ? 0 : Number(fraction));
  return Number.isSafeInteger(value) ? value : null;
}

export function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export type TotalCheck = "match" | "mismatch" | "unknown";

export function checkVisibleTotal(
  data: unknown,
  amountMinor: number,
  currency: string,
): TotalCheck {
  const probe = parsedFrom(TotalProbeSchema, data);
  if (probe === null) return "unknown";
  const exponent = currencyExponent(currency);
  const found = probe.texts.flatMap((text) =>
    [...text.matchAll(AMOUNT)]
      .map((match) => minorUnits(match[0].trim(), exponent))
      .filter((value): value is number => value !== null && value > 0),
  );
  if (found.length === 0) return "unknown";
  return found.includes(amountMinor) ? "match" : "mismatch";
}

function digitPattern(value: string): RegExp | null {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{8,19}$/.test(digits)) return null;
  return new RegExp(digits.split("").join("[\\s\\u00a0-]?"), "g");
}

export function redactFilled<T>(value: T, secrets: readonly string[]): T {
  const known = secrets.filter((secret) => secret.length > 0);
  const patterns = known.map(digitPattern).filter((pattern) => pattern !== null);
  const scrub = (text: string) =>
    scrubString(patterns.reduce((out, pattern) => out.replace(pattern, DEFAULT_REDACTED), text));
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return scrub(current);
    if (Array.isArray(current)) return current.map(walk);
    if (current !== null && typeof current === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) out[key] = walk(item);
      return out;
    }
    return current;
  };
  return walk(redactKnownValues(value, known)) as T;
}
