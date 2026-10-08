import { walkStrings } from "./reference-validator.ts";
import type { WorkflowDef } from "./types.ts";
import type { ValidationError } from "./validator.ts";

export type PlaceholderTier = "tokens" | "all";

export type DestinationPlaceholderKind =
  | "token"
  | "template"
  | "placeholder_email"
  | "placeholder_host"
  | "placeholder_phone"
  | "placeholder_channel"
  | "placeholder_webhook";

export interface DestinationPlaceholderViolation {
  step_id: string | null;
  path: string;
  kind: DestinationPlaceholderKind;
  match: string;
  message: string;
}

interface PlaceholderHit {
  kind: DestinationPlaceholderKind;
  match: string;
}

const TOKEN_RE = /\b(?:REPLACE_ME|CHANGE_ME|TODO|FIXME|TBD)\b/g;
const ANGLE_PLACEHOLDER_RE =
  /<(?:recipient|email|address|channel|webhook|url|your[_-][a-z0-9_-]+)>/gi;
const MUSTACHE_RE = /\{\{[^{}]*\}\}/g;
const PHONE_RES: readonly RegExp[] = [
  /(?<!\d)(?:\+?1[-. ]?)?\(?555\)?[-. ]?01\d{2}(?!\d)/g,
  /(?<!\d)123[-. ]?456[-. ]?7890(?!\d)/g,
  /\+1234567890(?!\d)/g,
  /(?<!\d)000[-. ]?000[-. ]?0000(?!\d)/g,
  /(?<![\w+])\+?\d*[xX]{3}[-. ]?[xX]{3}[-. ]?[xX]{4}(?![\w-])/g,
];
const CHANNEL_RE = /(?<![\w/#&?=.-])#(?:your-channel|channel|example)(?![\w-])/gi;
const EMAIL_RE = /\b([a-z0-9._%+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi;
const URL_RE = /https?:\/\/([^\s/?#"'<>`]+)/gi;
const SLACK_HOOK_RE = /hooks\.slack\.com\/services\/([^\s/"'`]+)\/([^\s/"'`]+)\/([^\s/"'`]+)/gi;
const RUNTIME_PLACEHOLDER_RE = /\$\{\s*(?:input|scope|item|cred|connector)\./;

const PLACEHOLDER_LOCAL_PART_RE = /^(?:test|user|example|someone|recipient|foo|you|me)\d*$/i;
const PLACEHOLDER_MAIL_REGISTRABLE = new Set([
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
]);
const PLACEHOLDER_HOST_REGISTRABLE = new Set(["example.com", "example.org", "example.net"]);
const PLACEHOLDER_TLDS = new Set(["example", "test", "invalid", "localhost"]);
const YOUR_MAIL_DOMAIN_RE = /your[-_]?(?:domain|company)/i;
const YOUR_HOST_RE = /your[-_]?(?:host|domain|server|company)/i;
const NULL_HOOK_SEGMENT_RE = /^[tb]?(?:0+|x+)$/i;
const NULL_HOOK_SECRET_RE = /^(?:0+|x+|y+|z+)$/i;

function labelsOf(host: string): string[] {
  return host.toLowerCase().split(".").filter(Boolean);
}

function hasPlaceholderTld(labels: string[]): boolean {
  return labels.length >= 2 && PLACEHOLDER_TLDS.has(labels[labels.length - 1] ?? "");
}

function isPlaceholderMailDomain(domain: string): boolean {
  const labels = labelsOf(domain);
  if (hasPlaceholderTld(labels)) return true;
  if (PLACEHOLDER_MAIL_REGISTRABLE.has(labels.slice(-2).join("."))) return true;
  return YOUR_MAIL_DOMAIN_RE.test(domain);
}

function isPlaceholderHost(host: string): boolean {
  const labels = labelsOf(host);
  if (hasPlaceholderTld(labels)) return true;
  if (PLACEHOLDER_HOST_REGISTRABLE.has(labels.slice(-2).join("."))) return true;
  return YOUR_HOST_RE.test(host);
}

function hostOfAuthority(authority: string): string {
  const withoutUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
  return withoutUserinfo.replace(/:\d+$/, "").toLowerCase();
}

function isNullSlackHook(team: string, bot: string, secret: string): boolean {
  return (
    NULL_HOOK_SEGMENT_RE.test(team) ||
    NULL_HOOK_SEGMENT_RE.test(bot) ||
    NULL_HOOK_SECRET_RE.test(secret)
  );
}

function tokenHits(text: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  for (const m of text.matchAll(TOKEN_RE)) hits.push({ kind: "token", match: m[0] });
  for (const m of text.matchAll(ANGLE_PLACEHOLDER_RE)) hits.push({ kind: "token", match: m[0] });
  for (const m of text.matchAll(MUSTACHE_RE)) hits.push({ kind: "template", match: m[0] });
  for (const re of PHONE_RES) {
    for (const m of text.matchAll(re)) hits.push({ kind: "placeholder_phone", match: m[0] });
  }
  for (const m of text.matchAll(CHANNEL_RE)) {
    hits.push({ kind: "placeholder_channel", match: m[0] });
  }
  return hits;
}

function addressHits(text: string): PlaceholderHit[] {
  if (RUNTIME_PLACEHOLDER_RE.test(text)) return [];
  const hits: PlaceholderHit[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const local = m[1] ?? "";
    const domain = m[2] ?? "";
    if (PLACEHOLDER_LOCAL_PART_RE.test(local) || isPlaceholderMailDomain(domain)) {
      hits.push({ kind: "placeholder_email", match: m[0] });
    }
  }
  for (const m of text.matchAll(URL_RE)) {
    const host = hostOfAuthority(m[1] ?? "");
    if (host && isPlaceholderHost(host)) hits.push({ kind: "placeholder_host", match: host });
  }
  for (const m of text.matchAll(SLACK_HOOK_RE)) {
    if (isNullSlackHook(m[1] ?? "", m[2] ?? "", m[3] ?? "")) {
      hits.push({ kind: "placeholder_webhook", match: m[0] });
    }
  }
  return hits;
}

export function findPlaceholderDestinations(text: string, tier: PlaceholderTier): PlaceholderHit[] {
  const hits = tokenHits(text);
  if (tier === "all") hits.push(...addressHits(text));
  return hits;
}

function placeholderDetail(match: string): string {
  return `placeholder destination "${match}" — this value must come from the user (ask with ask_user_text or ask_user_form); never fill it with a placeholder.`;
}

export function detectPlaceholderDestinations(
  def: WorkflowDef,
  opts: { tier: PlaceholderTier },
): DestinationPlaceholderViolation[] {
  const violations: DestinationPlaceholderViolation[] = [];
  const seen = new Set<string>();
  const scan = (
    value: unknown,
    path: string,
    step_id: string | null,
    tier: PlaceholderTier = opts.tier,
  ): void => {
    walkStrings(
      value,
      (text, at) => {
        for (const hit of findPlaceholderDestinations(text, tier)) {
          const key = `${at}\u0000${hit.kind}\u0000${hit.match}`;
          if (seen.has(key)) continue;
          seen.add(key);
          violations.push({
            step_id,
            path: at,
            kind: hit.kind,
            match: hit.match,
            message: `${at}: ${placeholderDetail(hit.match)}`,
          });
        }
      },
      path,
    );
  };

  for (const step of def.steps) {
    const base = `steps.${step.id}`;
    if (step.kind === "request") {
      scan(step.url, `${base}.url`, step.id);
      scan(
        step.path,
        `${base}.path`,
        step.id,
        step.connector_id !== undefined ? "tokens" : opts.tier,
      );
      scan(step.headers, `${base}.headers`, step.id);
      scan(step.query, `${base}.query`, step.id);
      scan(step.body, `${base}.body`, step.id);
      scan(step.graphql?.variables, `${base}.graphql.variables`, step.id);
      scan(step.mcp?.arguments, `${base}.mcp.arguments`, step.id);
      scan(step.report_delivery?.to, `${base}.report_delivery.to`, step.id);
      scan(step.report_delivery?.from, `${base}.report_delivery.from`, step.id);
    } else if (step.kind === "transform") {
      scan(step.expression, `${base}.expression`, step.id);
    }
  }
  scan(def.output_transform, "output_transform", null);
  scan(def.output_transform_function, "output_transform_function", null);
  scan(def.input_schema_sample, "input_schema_sample", null);
  return violations;
}

export function placeholderDestinationErrors(
  violations: ReadonlyArray<DestinationPlaceholderViolation>,
): ValidationError[] {
  return violations.map((v) => ({ path: v.path, message: placeholderDetail(v.match) }));
}
