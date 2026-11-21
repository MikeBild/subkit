import type { components } from "@cli-core/engine-api/openapi";

type Connector = components["schemas"]["Connector"];
export type Health = "healthy" | "degraded" | "reauth";
export type Env = "test" | "prod";
export type SignInMethod = "account" | "key" | "secured";
export const HEALTH_TONE = { healthy: "success", degraded: "warning", reauth: "danger" } as const;

export function connectorHealth(c: Pick<Connector, "health_state" | "needs_reauth">): Health {
  if (c.needs_reauth || c.health_state === "needs_reauth") return "reauth";
  return c.health_state === "ok" ? "healthy" : "degraded";
}

export function signInMethod(authType: Connector["auth_type"]): SignInMethod {
  if (authType === "oauth2" || authType === "oauth2_client") return "account";
  if (
    authType === "aws_sigv4" ||
    authType === "signed_jwt" ||
    authType === "token_mint" ||
    authType === "oauth2_private_key"
  )
    return "secured";
  return "key";
}

export interface ConnectorCard {
  id: string;
  name: string;
  account: string;
  env: Env;
  health: Health;
  method: SignInMethod;
  lastSync: string;
  usedBy: number;
  enabled: boolean;
  kind: ConnectorKind | null;
  category: string;
  describedBy: unknown;
  driver: string | null;
  tools: number | null;
}

export type ConnectorKind = "oauth" | "mcp" | "key";
export const CONNECTOR_KINDS: readonly ConnectorKind[] = ["oauth", "mcp", "key"];

export function connectorKind(c: Pick<Connector, "driver" | "auth_type">): ConnectorKind | null {
  if (c.driver === "mcp") return "mcp";
  if (
    c.auth_type === "oauth2" ||
    c.auth_type === "oauth2_client" ||
    c.auth_type === "oauth2_private_key"
  )
    return "oauth";
  if (["header", "query", "bearer", "basic", "aws_sigv4"].includes(c.auth_type)) return "key";
  return null;
}

export function connectorCard(c: Connector, usedBy: number): ConnectorCard {
  return {
    id: c.id,
    name: c.display_name,
    account: c.slug,
    env: c.environment === "prod" ? "prod" : "test",
    health: connectorHealth(c),
    method: signInMethod(c.auth_type),
    lastSync: c.last_tested_at ?? c.updated_at,
    usedBy,
    enabled: c.enabled,
    kind: connectorKind(c),
    category: c.category,
    describedBy: c.description_source,
    driver: c.driver || null,
    tools: c.driver === "mcp" && typeof c.tools_count === "number" ? c.tools_count : null,
  };
}

export function usageBySlug(
  workflows: readonly { connectors: readonly string[] }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of workflows)
    for (const slug of new Set(w.connectors)) m.set(slug, (m.get(slug) ?? 0) + 1);
  return m;
}

export function sortCards(cards: readonly ConnectorCard[]): ConnectorCard[] {
  const rank: Record<Health, number> = { reauth: 0, degraded: 1, healthy: 2 };
  return [...cards].sort((a, b) => rank[a.health] - rank[b.health] || a.name.localeCompare(b.name));
}

export const SIGNIN_EVENT = "connector.oauth.signin_finished";

export interface SigninFinished {
  connectorId: string;
  outcome: "succeeded" | "failed";
  reason: string | null;
}

export function signinFinished(event: string, data: string): SigninFinished | null {
  if (event !== SIGNIN_EVENT) return null;
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    return null;
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.connector_id !== "string") return null;
  if (b.outcome !== "succeeded" && b.outcome !== "failed") return null;
  return {
    connectorId: b.connector_id,
    outcome: b.outcome,
    reason: typeof b.reason === "string" ? b.reason : null,
  };
}

export function signinStrip(s: SigninFinished): {
  tone: "success" | "danger";
  key: "cn.signin.succeeded" | "cn.signin.failed";
} {
  return s.outcome === "succeeded"
    ? { tone: "success", key: "cn.signin.succeeded" }
    : { tone: "danger", key: "cn.signin.failed" };
}

export type TestOutcome = "ok" | "slow" | "failed";
export function testOutcome(
  r: { ok: boolean; warning_only?: boolean | undefined },
  health: Health,
): TestOutcome {
  if (!r.ok) return "failed";
  return r.warning_only || health === "degraded" ? "slow" : "ok";
}

export interface CardFilter {
  q: string;
  attention: boolean;
  kind?: ConnectorKind | "all";
  category?: string;
  createdBy?: "all" | "ai" | "person";
}

export function filterCards(cards: readonly ConnectorCard[], f: CardFilter): ConnectorCard[] {
  const n = f.q.trim().toLocaleLowerCase();
  return cards.filter(
    (c) =>
      (!f.attention || c.health !== "healthy") &&
      (!f.kind || f.kind === "all" || c.kind === f.kind) &&
      (!f.category || f.category === "all" || c.category === f.category) &&
      (!f.createdBy ||
        f.createdBy === "all" ||
        (f.createdBy === "ai" ? c.describedBy === "llm" : c.describedBy !== "llm")) &&
      (!n ||
        c.name.toLocaleLowerCase().includes(n) ||
        c.account.toLocaleLowerCase().includes(n) ||
        c.category.toLocaleLowerCase().includes(n)),
  );
}

export function groupCards<T>(
  cards: readonly T[],
  key: ((c: T) => string) | null,
): [string, T[]][] {
  if (!key) return [["", [...cards]]];
  const groups = new Map<string, T[]>();
  for (const c of cards) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  return [...groups.entries()];
}

export type Attention = "" | "not_ok";

export const isAttention = (v: string): v is Attention => v === "" || v === "not_ok";

export function attentionFromSearch(search: string): Attention {
  const value = new URLSearchParams(search).get("health") ?? "";
  return isAttention(value) ? value : "";
}
