import { placeholdersOf, type RecordUrlPattern, safeWebUrl } from "./record-url-patterns.ts";
import type { ConnectorTemplate } from "./templates.ts";

export const RECORD_LINK_LIMIT = 20;
const LABEL_MAX = 120;
const VALUE_MAX = 200;
const REDACTION_MARKERS = ["***REDACTED", "[REDACTED"];

export interface RecordLink {
  label: string | null;
  url: string;
  connector: string;
  connector_name: string;
  step_key: string;
}

export interface RecordLinkStep {
  step_key: string;
  kind: string;
  status: string;
  held: boolean;
  output_preview: unknown;
  request_meta: unknown;
  redacted_fields: readonly unknown[];
  result_storage_uri: string | null;
}

type Values = Record<string, string>;

export function isSealedPayload(value: unknown): boolean {
  return record(value)?.$sensitive === true;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fieldAt(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const part of path.split(".")) {
    const current = record(node);
    if (!current || !Object.hasOwn(current, part)) return undefined;
    node = current[part];
  }
  return node;
}

function containsRedaction(value: unknown): boolean {
  if (typeof value === "string") return REDACTION_MARKERS.some((marker) => value.includes(marker));
  if (Array.isArray(value)) return value.some(containsRedaction);
  const node = record(value);
  return node ? Object.values(node).some(containsRedaction) : false;
}

function scalar(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || value.length === 0 || value.length > VALUE_MAX) return null;
  return value;
}

function resolve(name: string, params: Values, output: unknown): string | null {
  if (Object.hasOwn(params, name)) return params[name] ?? null;
  return scalar(fieldAt(output, name));
}

function render(
  template: string,
  params: Values,
  output: unknown,
  encode: (value: string) => string | null,
): string | null {
  let rendered = template;
  for (const name of placeholdersOf(template)) {
    const value = resolve(name, params, output);
    const encoded = value === null ? null : encode(value);
    if (encoded === null) return null;
    rendered = rendered.split(`{${name}}`).join(encoded);
  }
  return rendered;
}

function pathSegment(value: string): string | null {
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return null;
  return encodeURIComponent(value);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function placeholderRegex(pattern: string, segment: string): { re: RegExp; names: string[] } {
  const names = placeholdersOf(pattern);
  const source = pattern
    .split(/(\{[A-Za-z_][A-Za-z0-9_.]*\})/)
    .map((part) => (/^\{.+\}$/.test(part) ? `(${segment})` : escapeRegex(part)))
    .join("");
  return { re: new RegExp(`^${source}$`), names };
}

function capture(pattern: string, segment: string, value: string): Values | null {
  const { re, names } = placeholderRegex(pattern, segment);
  const match = re.exec(value);
  if (!match) return null;
  const out: Values = {};
  for (const [index, name] of names.entries()) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[index + 1] ?? "");
    } catch {
      return null;
    }
    out[name] = decoded;
  }
  return out;
}

function templateParts(baseUrl: string | null): { host: string; path: string } | null {
  if (!baseUrl) return null;
  const match = /^https?:\/\/([^/]+)(\/.*)?$/.exec(baseUrl);
  if (!match) return null;
  return { host: match[1] ?? "", path: (match[2] ?? "").replace(/\/+$/, "") };
}

function relativePath(pathname: string, prefixes: readonly RegExp[]): string {
  for (const prefix of prefixes) {
    const match = prefix.exec(pathname);
    if (match) return pathname.slice(match[0].length) || "/";
  }
  return pathname;
}

interface RequestFacts {
  driver: "http" | "graphql";
  method: string;
  url: URL | null;
  base_url: string | null;
}

function requestFacts(meta: unknown): RequestFacts | null {
  const node = record(meta);
  if (!node || (node.driver !== "http" && node.driver !== "graphql")) return null;
  const method = typeof node.method === "string" ? node.method.toUpperCase() : "POST";
  const connector = record(node.connector);
  const base_url = typeof connector?.base_url === "string" ? connector.base_url : null;
  let url: URL | null = null;
  if (typeof node.url === "string") {
    try {
      url = new URL(node.url);
    } catch {
      url = null;
    }
  }
  return { driver: node.driver, method, url, base_url };
}

function requestParams(template: ConnectorTemplate, facts: RequestFacts): Values | null {
  if (facts.driver === "graphql") return {};
  if (facts.url?.protocol !== "https:") return null;
  const declared = templateParts(template.base_url);
  const hostParams = declared ? capture(declared.host, "[^.]+", facts.url.host) : {};
  if (!hostParams) return null;
  return hostParams;
}

function pathParams(
  template: ConnectorTemplate,
  entry: RecordUrlPattern,
  facts: RequestFacts,
): Values | null {
  if (facts.driver === "graphql") return entry.path === undefined ? {} : null;
  if (!facts.url || entry.path === undefined) return null;
  const prefixes: RegExp[] = [];
  const resolved = templateParts(facts.base_url);
  if (resolved?.path) prefixes.push(new RegExp(`^${escapeRegex(resolved.path)}(?=/|$)`));
  const declared = templateParts(template.base_url);
  if (declared?.path) {
    const { re } = placeholderRegex(declared.path, "[^/]+");
    prefixes.push(new RegExp(`${re.source.slice(0, -1)}(?=/|$)`));
  }
  const rest = relativePath(facts.url.pathname.replace(/\/+$/, "") || "/", prefixes);
  return capture(entry.path, "[^/]+", rest);
}

function conditionHolds(entry: RecordUrlPattern, output: unknown): boolean {
  if (!entry.when) return true;
  return fieldAt(output, entry.when.field) === entry.when.equals;
}

function linkUrl(
  template: ConnectorTemplate,
  entry: RecordUrlPattern,
  params: Values,
  output: unknown,
): string | null {
  if (entry.url_field !== undefined) {
    const direct = safeWebUrl(fieldAt(output, entry.url_field), template.web_hosts);
    if (direct) return direct;
  }
  if (entry.url_template === undefined) return null;
  return safeWebUrl(render(entry.url_template, params, output, pathSegment), template.web_hosts);
}

function linkLabel(entry: RecordUrlPattern, params: Values, output: unknown): string | null {
  if (entry.label === undefined) return null;
  const label = render(entry.label, params, output, (value) => value)
    ?.replace(/\s+/g, " ")
    .trim();
  if (!label || containsRedaction(label)) return null;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

function unwrapOutput(preview: unknown): unknown {
  const node = record(preview);
  if (node && Object.keys(node).length === 2 && "value" in node && Array.isArray(node.warnings))
    return node.value;
  return preview;
}

function stepEligible(step: RecordLinkStep): boolean {
  return (
    step.kind === "request" &&
    step.status === "succeeded" &&
    !step.held &&
    step.result_storage_uri === null &&
    step.redacted_fields.length === 0 &&
    step.output_preview !== null &&
    step.output_preview !== undefined &&
    !isSealedPayload(step.output_preview) &&
    !isSealedPayload(step.request_meta)
  );
}

export function recordLinkForStep(
  template: ConnectorTemplate,
  step: RecordLinkStep,
): RecordLink | null {
  if (!stepEligible(step) || template.record_url_patterns.length === 0) return null;
  const facts = requestFacts(step.request_meta);
  if (!facts || facts.driver !== template.driver) return null;
  const output = unwrapOutput(step.output_preview);
  if (!record(output) || containsRedaction(output)) return null;
  const hostParams = requestParams(template, facts);
  if (!hostParams) return null;
  for (const entry of template.record_url_patterns) {
    if (facts.driver === "http" && !(entry.methods as readonly string[]).includes(facts.method))
      continue;
    const fromPath = pathParams(template, entry, facts);
    if (!fromPath || !conditionHolds(entry, output)) continue;
    const params = { ...hostParams, ...fromPath };
    const url = linkUrl(template, entry, params, output);
    if (!url) continue;
    return {
      label: linkLabel(entry, params, output),
      url,
      connector: template.slug,
      connector_name: template.name.replace(/\s*\([^)]*\)$/, ""),
      step_key: step.step_key,
    };
  }
  return null;
}

export function connectorIdOf(step: Pick<RecordLinkStep, "request_meta">): string | null {
  const id = record(record(step.request_meta)?.connector)?.connector_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function deriveRecordLinks(
  steps: readonly RecordLinkStep[],
  templateFor: (connectorId: string) => ConnectorTemplate | null,
): RecordLink[] {
  const links: RecordLink[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (links.length >= RECORD_LINK_LIMIT) break;
    const connectorId = connectorIdOf(step);
    const template = connectorId ? templateFor(connectorId) : null;
    if (!template) continue;
    const link = recordLinkForStep(template, step);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    links.push(link);
  }
  return links;
}
