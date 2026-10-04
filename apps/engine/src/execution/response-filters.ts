import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { tenantDlpRules } from "../db/schema/index.ts";

export type DlpAction = "mask" | "drop" | "hash";

export interface DlpRule {
  id?: string;
  path_match: string;
  pattern_regex?: string | null;
  action: DlpAction;
  reason?: string | null;
  enabled?: boolean;
}

export interface RedactedField {
  path: string;
  action: DlpAction;
  reason: string | null;
}

export interface DlpResult<T> {
  value: T;
  redacted: RedactedField[];
}

export const DEFAULT_DLP_RULES: readonly DlpRule[] = [
  {
    path_match: "**.email",
    pattern_regex: "^[^@]+@[^@]+\\.[^@]{2,}$",
    action: "mask",
    reason: "email_pii",
  },
  {
    path_match: "**.email_address",
    pattern_regex: "^[^@]+@[^@]+\\.[^@]{2,}$",
    action: "mask",
    reason: "email_pii",
  },
  {
    path_match: "**.phone",
    pattern_regex: "^[+()\\d\\s-]{8,}$",
    action: "mask",
    reason: "phone_pii",
  },
  {
    path_match: "**.ssn",
    action: "mask",
    reason: "ssn_pii",
  },
  {
    path_match: "**.credit_card",
    pattern_regex: "^\\d{12,19}$",
    action: "mask",
    reason: "pan_pii",
  },
];

interface CacheEntry {
  rules: DlpRule[];
  expires_at: number;
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function resetDlpCache(tenant_id?: string): void {
  if (tenant_id) CACHE.delete(tenant_id);
  else CACHE.clear();
}

export async function loadDlpRules(tenant_id: string, db: Db): Promise<DlpRule[]> {
  const now = Date.now();
  const cached = CACHE.get(tenant_id);
  if (cached && cached.expires_at > now) return cached.rules;
  const rows = await db
    .select()
    .from(tenantDlpRules)
    .where(and(eq(tenantDlpRules.tenant_id, tenant_id), eq(tenantDlpRules.enabled, true)));
  const db_rules: DlpRule[] = rows.map((r) => ({
    id: r.id,
    path_match: r.path_match,
    pattern_regex: r.pattern_regex ?? null,
    action: r.action as DlpAction,
    reason: r.reason ?? null,
    enabled: r.enabled,
  }));
  const rules = [...db_rules, ...DEFAULT_DLP_RULES.map((r) => ({ ...r }))];
  CACHE.set(tenant_id, { rules, expires_at: now + CACHE_TTL_MS });
  return rules;
}

function pathMatcher(expr: string): (segments: string[]) => boolean {
  const parts = expr.split(".");
  return (segments) => matchHere(parts, 0, segments, 0);
}

function matchHere(pat: string[], pi: number, seg: string[], si: number): boolean {
  while (pi < pat.length) {
    const p = pat[pi]!;
    if (p === "**") {
      if (pi === pat.length - 1) return true;
      for (let k = si; k <= seg.length; k++) {
        if (matchHere(pat, pi + 1, seg, k)) return true;
      }
      return false;
    }
    if (si >= seg.length) return false;
    if (p !== "*" && p !== seg[si]) return false;
    pi++;
    si++;
  }
  return si === seg.length;
}

function hashValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `sha256:${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;
}

function applyAction(value: unknown, action: DlpAction): unknown {
  if (action === "drop") return undefined;
  if (action === "hash") return hashValue(value);
  if (typeof value === "string") {
    if (value.length <= 4) return "****";
    return `${value.slice(0, 2)}****${value.slice(-2)}`;
  }
  return "***redacted***";
}

export function applyDlpFilters<T>(value: T, rules: DlpRule[]): DlpResult<T> {
  const compiled = rules
    .filter((r) => r.enabled !== false)
    .map((r) => ({
      rule: r,
      match: pathMatcher(r.path_match),
      re: r.pattern_regex ? new RegExp(r.pattern_regex) : null,
    }));
  const redacted: RedactedField[] = [];

  const walk = (node: unknown, segments: string[]): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node !== "object") return node;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (let i = 0; i < node.length; i++) {
        out.push(walk(node[i], [...segments, String(i)]));
      }
      return out;
    }
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const path = [...segments, k];
      let matched: (typeof compiled)[number] | null = null;
      for (const c of compiled) {
        if (!c.match(path)) continue;
        if (c.re !== null) {
          if (typeof v !== "string" || !c.re.test(v)) continue;
        }
        matched = c;
        break;
      }
      if (matched) {
        redacted.push({
          path: path.join("."),
          action: matched.rule.action,
          reason: matched.rule.reason ?? null,
        });
        const replaced = applyAction(v, matched.rule.action);
        if (matched.rule.action === "drop") continue;
        out[k] = replaced;
      } else {
        out[k] = walk(v, path);
      }
    }
    return out;
  };

  return { value: walk(value, []) as T, redacted };
}
