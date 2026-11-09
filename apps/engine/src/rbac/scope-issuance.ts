import { isMcpModeMarkerScope, WILDCARD_SCOPE } from "../auth/scopes.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import { ALL_PERMISSION_NAMES, isOperatorPermission } from "./catalog.ts";
import { exceedsMessage, isUnbounded, storedScopes } from "./core/scope-issuance.ts";
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

export class ScopeExceedsIssuerError extends Error {
  readonly code = "scope_exceeds_issuer";
  constructor(
    readonly scopes: string[],
    readonly operator_only: string[],
  ) {
    super(exceedsMessage(scopes, operator_only));
  }
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
