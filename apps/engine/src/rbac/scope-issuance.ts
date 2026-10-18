import { isMcpModeMarkerScope, WILDCARD_SCOPE } from "../auth/scopes.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import { ALL_PERMISSION_NAMES, isOperatorPermission } from "./catalog.ts";
import { principalHolds } from "./evaluator.ts";
import { tenantIsOperator } from "./operator.ts";

export type ScopeIssuer =
  | { kind: "principal"; principal: ResolvedPrincipal }
  | { kind: "login" }
  | { kind: "system" };

const KNOWN_SCOPES: ReadonlySet<string> = new Set([WILDCARD_SCOPE, ...ALL_PERMISSION_NAMES]);

export class UnknownScopeError extends Error {
  readonly code = "unknown_scope";
  constructor(readonly scopes: string[]) {
    super(
      `Unknown scope(s): ${scopes.join(", ")}. Use permission names from GET /v1/rbac/permissions, '*', or mcp:read, mcp:authoring, mcp:admin.`,
    );
  }
}

function exceedsMessage(scopes: string[], operatorOnly: string[]): string {
  if (scopes.includes(WILDCARD_SCOPE)) {
    return "Only a credential without scope limits can issue '*'. List the permissions the key needs instead.";
  }
  const first = operatorOnly[0];
  if (first && operatorOnly.length === scopes.length) {
    return `${operatorOnly.join(", ")} affects the whole engine; only the engine operator can grant it.`;
  }
  const base = `You cannot grant ${scopes.join(", ")} because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them.`;
  return first
    ? `${base} ${operatorOnly.join(", ")} affects the whole engine; only the engine operator can grant it.`
    : base;
}

export class ScopeExceedsIssuerError extends Error {
  readonly code = "scope_exceeds_issuer";
  constructor(
    readonly scopes: string[],
    readonly operator_only: string[],
  ) {
    super(exceedsMessage(scopes, operator_only));
  }
}

function isUnbounded(principal: ResolvedPrincipal): boolean {
  if (principal.product_id) return false;
  if (principal.provider === "portal_token") return false;
  const scopes = principal.scopes;
  return scopes === undefined || scopes.length === 0 || scopes.includes(WILDCARD_SCOPE);
}

async function issuerHolds(
  db: Executor,
  principal: ResolvedPrincipal,
  unbounded: boolean,
  scope: string,
): Promise<boolean> {
  if (scope === WILDCARD_SCOPE) return unbounded;
  if (isMcpModeMarkerScope(scope) && !unbounded) return principal.scopes?.includes(scope) === true;
  return principalHolds(db, principal, scope);
}

async function assertIssuerHolds(
  db: Executor,
  principal: ResolvedPrincipal,
  scopes: string[],
): Promise<void> {
  const unbounded = isUnbounded(principal);
  const exceeded: string[] = [];
  const operatorOnly: string[] = [];
  for (const scope of scopes) {
    if (await issuerHolds(db, principal, unbounded, scope)) continue;
    exceeded.push(scope);
    if (isOperatorPermission(scope)) operatorOnly.push(scope);
  }
  if (exceeded.length > 0) throw new ScopeExceedsIssuerError(exceeded, operatorOnly);
}

async function effectiveScopes(
  db: Executor,
  scopes: string[],
  tenantId: string,
): Promise<string[]> {
  const known = scopes.filter((scope) => KNOWN_SCOPES.has(scope));
  if (!known.some(isOperatorPermission)) return known;
  if (await tenantIsOperator(db, tenantId)) return known;
  return known.filter((scope) => !isOperatorPermission(scope));
}

function storedScopes(scopes: string[] | null | undefined): string[] {
  return scopes && scopes.length > 0 ? [...new Set(scopes)] : [WILDCARD_SCOPE];
}

export async function authorizeRequestedScopes(
  db: Executor,
  issuer: ScopeIssuer,
  requested: string[] | undefined,
): Promise<string[]> {
  if (issuer.kind !== "principal") return requested ?? [WILDCARD_SCOPE];
  const principal = issuer.principal;
  if (requested === undefined) {
    if (isUnbounded(principal)) return [WILDCARD_SCOPE];
    const inherited = storedScopes(principal.scopes);
    await assertIssuerHolds(
      db,
      principal,
      await effectiveScopes(db, inherited, principal.tenant_id),
    );
    return inherited;
  }
  const unique = storedScopes(requested);
  const unknown = unique.filter((scope) => !KNOWN_SCOPES.has(scope));
  if (unknown.length > 0) throw new UnknownScopeError(unknown);
  await assertIssuerHolds(db, principal, unique);
  return unique;
}

export async function authorizeRetainedScopes(
  db: Executor,
  issuer: ScopeIssuer,
  stored: string[] | null | undefined,
  tenantId: string,
): Promise<void> {
  if (issuer.kind !== "principal") return;
  const retained = await effectiveScopes(db, storedScopes(stored), tenantId);
  await assertIssuerHolds(db, issuer.principal, retained);
}
