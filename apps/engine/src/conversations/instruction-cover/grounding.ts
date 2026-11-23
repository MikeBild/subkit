import { normalizeForQuote, occursBounded } from "@shared/quote-text.ts";
import { isContentKey } from "./bound-action.ts";
import { SAFE_HEADERS } from "./effect-vocabulary.ts";
import { canonicalNumber, localParts, numberCandidates, type SpokenFacts } from "./spoken.ts";
import { equivalentValues } from "./translations.ts";

export interface Evidence {
  readonly named: ReadonlySet<string>;
}

export const NO_EVIDENCE: Evidence = { named: new Set() };

export interface GroundingContext {
  readonly window: SpokenFacts;
  readonly addressees: SpokenFacts;
  readonly evidence: Evidence;
  readonly recipient_evidence?: Evidence;
  readonly now: Date;
  readonly timezone: string;
}

export type GroundingReason =
  | "recipient_not_named"
  | "target_not_named"
  | "value_not_said"
  | "date_not_said"
  | "header_not_requested"
  | "undecidable";

export interface GroundingResult {
  readonly recipients: readonly string[];
  readonly failure: { readonly reason: GroundingReason; readonly detail: string } | null;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const WHOLE_EMAIL = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;
const URL_RE = /https?:\/\/[^\s<>"'„“”‚‘’»«]+/gu;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/u;
const CLOCK = /^(\d{1,2}):(\d{2})(?::\d{2})?$/u;
const MAX_STRUCTURED_CHARS = 200;
const MAX_NODES = 2000;

const RECIPIENT_KEY =
  /^(?:to|cc|bcc|recipients?|receivers?|emails?|e_?mail_?address(?:es)?|address(?:es)?|attendees?|invitees?|participants?|assignees?|phone|phone_?numbers?|mobile|channel|channels|chat|chat_?id|room|conversation|thread|user|users|username|member|customer|client|contact|contacts|destination|webhook|url|uri|link)$/iu;

const TARGET_KEY =
  /^(?:id|ids|key|slug|number|name|target|repo|repository|project|board|list|folder|calendar|page|database|sheet|table|workflow|task|issue|ticket|owner|account|team|group|label|labels|tag|tags|queue|pipeline|stage|.*_(?:id|ids|key|slug|number)|.*(?:Id|Ids|Key))$/u;

const FORMAT_KEY =
  /^(?:type|format|content_?type|contentType|mime_?type|mimeType|parse_?mode|encoding|charset|lang|language|locale|unit|currency)$/u;

const FORMAT_VALUE =
  /^(?:text|html|plain|markdown|mrkdwn|json|utf-?8|(?:text|application)\/[\w.+-]+)$/iu;

const STRUCTURAL_CONNECTOR_KEYS = new Set([
  "connector",
  "connector_id",
  "connector_slug",
  "method",
  "response_mode",
  "timeout_ms",
  "allow_writes",
  "row_limit",
]);

const HEADER_FORMAT_VALUE =
  /^(?:\*\/\*|(?:text|application)\/[\w.+*-]+(?:;\s*charset=[\w-]+)?|[a-z]{2}(?:-[A-Z]{2})?)$/u;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function spokenText(value: string, ctx: GroundingContext): boolean {
  const normalized = normalizeForQuote(value);
  return normalized.length > 0 && occursBounded(normalized, ctx.window.text);
}

function known(value: string, ctx: GroundingContext): boolean {
  return ctx.evidence.named.has(value) || spokenText(value, ctx);
}

function timeSaid(hour: number, minute: number, ctx: GroundingContext): boolean {
  if (ctx.window.times.has(`${pad(hour)}:${pad(minute)}`)) return true;
  const wanted = hour * 60 + minute;
  for (const start of ctx.window.times) {
    const [h, m] = start.split(":").map(Number);
    const from = (h ?? 0) * 60 + (m ?? 0);
    for (const duration of ctx.window.durations) {
      if (from + duration === wanted) return true;
    }
  }
  return false;
}

function translated(value: string, ctx: GroundingContext): boolean {
  return equivalentValues(normalizeForQuote(value)).some((other) =>
    occursBounded(other, ctx.window.text),
  );
}

function numberSaid(value: number, key: string, ctx: GroundingContext): boolean {
  if (ctx.window.numbers.has(canonicalNumber(value))) return true;
  if (/cents?|minor/iu.test(key) && ctx.window.numbers.has(canonicalNumber(value / 100))) {
    return true;
  }
  return ctx.evidence.named.has(String(value));
}

function dateFailure(match: RegExpExecArray, ctx: GroundingContext): string | null {
  const [raw, year, month, day, hour, minute, zone] = match;
  let y = Number(year);
  let mo = Number(month);
  let d = Number(day);
  let h = hour === undefined ? null : Number(hour);
  let mi = minute === undefined ? null : Number(minute);
  if (zone !== undefined && h !== null) {
    const instant = new Date(raw.replace(" ", "T"));
    if (Number.isNaN(instant.getTime())) return raw;
    const local = localParts(instant, ctx.timezone);
    y = local.year;
    mo = local.month;
    d = local.day;
    h = local.hour;
    mi = local.minute;
  }
  const short = `${pad(mo)}-${pad(d)}`;
  const thisYear = localParts(ctx.now, ctx.timezone).year;
  const dateSaid =
    ctx.window.dates.has(`${y}-${short}`) ||
    (ctx.window.dates.has(short) &&
      !hasYearFor(ctx.window.dates, short) &&
      (y === thisYear || y === thisYear + 1));
  if (!dateSaid) return raw;
  if (h === null || mi === null || (h === 0 && mi === 0)) return null;
  return timeSaid(h, mi, ctx) ? null : raw;
}

function hasYearFor(dates: ReadonlySet<string>, short: string): boolean {
  for (const key of dates) {
    if (key.length > short.length && key.endsWith(short)) return true;
  }
  return false;
}

function digitsSaid(value: string, ctx: GroundingContext): boolean {
  const tokens = [...value.matchAll(/\d+(?:[.,]\d+)*/gu)].map((match) => match[0]);
  return tokens.every((token) => {
    const candidates = numberCandidates(token);
    if (candidates.some((candidate) => ctx.window.numbers.has(candidate))) return true;
    return token
      .split(/[.,]/u)
      .every((part) => ctx.window.numbers.has(canonicalNumber(Number(part))));
  });
}

interface Walk {
  readonly ctx: GroundingContext;
  readonly recipients: Set<string>;
  failure: GroundingResult["failure"];
  nodes: number;
  readonly collect_all: boolean;
}

function fail(walk: Walk, reason: GroundingReason, detail: string): void {
  if (!walk.failure) walk.failure = { reason, detail: detail.slice(0, 120) };
}

function checkString(walk: Walk, key: string, value: string): void {
  const { ctx } = walk;
  if (isContentKey(key)) return;
  if (value.length > MAX_STRUCTURED_CHARS) {
    fail(walk, "undecidable", `${key}: value too long to check`);
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  const urls = [...trimmed.matchAll(URL_RE)].map((match) =>
    match[0].replace(/[.,;:!?)\]}]+$/u, ""),
  );
  const withoutUrls = trimmed.replace(URL_RE, " ");
  const emails = [...withoutUrls.matchAll(EMAIL)].map((match) => match[0]);
  for (const email of emails) {
    walk.recipients.add(email);
    const looked = (ctx.recipient_evidence ?? ctx.evidence).named.has(email);
    if (!ctx.addressees.emails.has(email) && !looked) fail(walk, "recipient_not_named", email);
  }
  for (const url of urls) {
    walk.recipients.add(url);
    if (!ctx.addressees.urls.has(url)) fail(walk, "recipient_not_named", url);
  }
  if (emails.length > 0 || urls.length > 0) return;
  const date = ISO_DATE.exec(trimmed);
  if (date) {
    const missing = dateFailure(date, ctx);
    if (missing) fail(walk, "date_not_said", `${key}: ${missing}`);
    return;
  }
  const clock = CLOCK.exec(trimmed);
  if (clock) {
    const said = timeSaid(Number(clock[1]), Number(clock[2]), ctx);
    if (!said) fail(walk, "date_not_said", `${key}: ${trimmed}`);
    return;
  }
  if (RECIPIENT_KEY.test(key)) {
    walk.recipients.add(trimmed);
    const named =
      ctx.addressees.handles.has(trimmed) ||
      ctx.evidence.named.has(trimmed) ||
      spokenText(trimmed, ctx);
    if (!named) fail(walk, "recipient_not_named", `${key}: ${trimmed}`);
    return;
  }
  if (TARGET_KEY.test(key)) {
    if (!known(trimmed, ctx)) fail(walk, "target_not_named", `${key}: ${trimmed}`);
    return;
  }
  if (FORMAT_KEY.test(key) || FORMAT_VALUE.test(trimmed) || known(trimmed, ctx)) return;
  if (translated(trimmed, ctx)) return;
  if (/\d/u.test(trimmed) && digitsSaid(trimmed, ctx)) return;
  fail(walk, "value_not_said", `${key}: ${trimmed}`);
}

function visit(walk: Walk, key: string, value: unknown, depth: number): void {
  if (walk.failure && !walk.collect_all) return;
  walk.nodes += 1;
  if (walk.nodes > MAX_NODES || depth > 8) {
    fail(walk, "undecidable", "arguments too large to check");
    return;
  }
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (typeof value === "string") {
    checkString(walk, key, value);
    return;
  }
  if (typeof value === "number") {
    if (isContentKey(key)) return;
    if (!numberSaid(value, key, walk.ctx)) fail(walk, "value_not_said", `${key}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(walk, key, item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      visit(walk, childKey, child, depth + 1);
    }
    return;
  }
  fail(walk, "undecidable", `${key}: unsupported value`);
}

function checkPath(walk: Walk, path: string): void {
  const [route = "", query = ""] = path.split("?", 2);
  if (/^https?:\/\//iu.test(route)) {
    fail(walk, "target_not_named", "absolute URL as path");
    return;
  }
  for (const raw of route.split("/")) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      fail(walk, "undecidable", "path cannot be decoded");
      return;
    }
    if (segment.length === 0 || /^[\p{L}_.~-]+$/u.test(segment)) {
      if (segment.length < 20) continue;
    }
    if (/^v\d+(?:\.\d+)?$/iu.test(segment)) continue;
    if (WHOLE_EMAIL.test(segment)) {
      walk.recipients.add(segment);
      if (!walk.ctx.addressees.emails.has(segment)) fail(walk, "recipient_not_named", segment);
      continue;
    }
    if (!known(segment, walk.ctx) && !(/^\d+$/u.test(segment) && digitsSaid(segment, walk.ctx))) {
      fail(walk, "target_not_named", `path segment ${segment}`);
    }
  }
  if (query.length > 0) {
    for (const [name, value] of new URLSearchParams(query)) visit(walk, name, value, 1);
  }
}

function checkHeaders(walk: Walk, headers: unknown): void {
  if (headers === null || headers === undefined) return;
  if (typeof headers !== "object" || Array.isArray(headers)) {
    fail(walk, "undecidable", "headers are not an object");
    return;
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    const text = typeof value === "string" ? value.trim() : null;
    if (text !== null && SAFE_HEADERS.has(name.toLowerCase()) && HEADER_FORMAT_VALUE.test(text)) {
      continue;
    }
    const asked =
      text !== null &&
      text.length <= MAX_STRUCTURED_CHARS &&
      spokenText(name, walk.ctx) &&
      spokenText(text, walk.ctx);
    if (!asked) fail(walk, "header_not_requested", name);
  }
}

function parsedBody(walk: Walk, body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    fail(walk, "undecidable", "body is not structured");
    return undefined;
  }
}

export function groundArguments(
  tool: string,
  args: Record<string, unknown>,
  ctx: GroundingContext,
  options: { collect_all?: boolean } = {},
): GroundingResult {
  const walk: Walk = {
    ctx,
    recipients: new Set(),
    failure: null,
    nodes: 0,
    collect_all: options.collect_all === true,
  };
  if (tool === "call_connector") {
    if (typeof args.path === "string") checkPath(walk, args.path);
    for (const [key, value] of Object.entries(args)) {
      if (STRUCTURAL_CONNECTOR_KEYS.has(key) || key === "path") continue;
      if (key === "headers") {
        checkHeaders(walk, value);
        continue;
      }
      if (key === "body") {
        const body = parsedBody(walk, value);
        if (body !== undefined && body !== null && typeof body === "object") {
          visit(walk, "payload", body, 1);
        } else if (body !== undefined && body !== null) {
          fail(walk, "undecidable", "body is not an object");
        }
        continue;
      }
      visit(walk, key, value, 1);
    }
  } else {
    for (const [key, value] of Object.entries(args)) visit(walk, key, value, 1);
  }
  return { recipients: [...walk.recipients].sort(), failure: walk.failure };
}

const LABEL_KEY =
  /^(?:name|title|display_?name|displayName|label|subject|summary|email|mail|login|username|handle|slug|real_?name|full_?name|first_?name|last_?name)$/u;
const IDENTIFIER_KEY = /^(?:id|gid|uid|key|number|iid|.*_(?:id|key|number)|.*(?:Id|Key))$/u;

function scalarText(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

interface LabelledRecord {
  readonly labels: readonly string[];
  readonly values: readonly string[];
}

function identityOf(record: LabelledRecord): string {
  const emails = record.values.filter((value) => WHOLE_EMAIL.test(value)).sort();
  return (emails.length > 0 ? emails : [...record.values].sort()).join("|");
}

function firstName(label: string): string | null {
  const parts = label.split(" ");
  const first = parts[0] ?? "";
  return parts.length >= 2 && /^\p{L}{3,}$/u.test(first) ? first : null;
}

export function buildEvidence(outputs: readonly unknown[], window: SpokenFacts): Evidence {
  const named = new Set<string>();
  const records: LabelledRecord[] = [];
  const said = window.text.toLowerCase();
  let budget = 20000;
  const walk = (value: unknown, depth: number): void => {
    budget -= 1;
    if (budget <= 0 || depth > 10 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const labels = entries.flatMap(([key, nested]) => {
      if (!LABEL_KEY.test(key) || typeof nested !== "string") return [];
      const normalized = normalizeForQuote(nested);
      return normalized.length >= 3 && !/^\d+$/u.test(normalized) ? [normalized] : [];
    });
    if (labels.length > 0) {
      const values = entries.flatMap(([key, nested]) => {
        if (!IDENTIFIER_KEY.test(key) && !LABEL_KEY.test(key)) return [];
        const text = scalarText(nested);
        return text === null ? [] : [text];
      });
      records.push({ labels, values });
    }
    for (const [, nested] of entries) walk(nested, depth + 1);
  };
  for (const output of outputs) walk(output, 0);
  const byFirstName = new Map<string, Set<string>>();
  for (const record of records) {
    for (const label of record.labels) {
      const first = firstName(label);
      if (first === null) continue;
      const identities = byFirstName.get(first) ?? new Set<string>();
      identities.add(identityOf(record));
      byFirstName.set(first, identities);
    }
  }
  for (const record of records) {
    const spoken = record.labels.some((label) => {
      if (occursBounded(label, window.text)) return true;
      const first = firstName(label);
      return first !== null && byFirstName.get(first)?.size === 1 && occursBounded(first, said);
    });
    if (!spoken) continue;
    for (const value of record.values) named.add(value);
  }
  return { named };
}
