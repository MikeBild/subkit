// External MCP server boot reconcile (#171).
//
// Zero-conf by default: with no `mcp.servers` config the engine boots and
// this reconcile is a no-op for every tenant. When an operator declares
// external MCP servers under `mcp.servers` (global) or a per-tenant overlay
// (`tenants.<id>.mcp.servers`), this pass walks every tenant and converges
// the `mcp_servers` table to match the declared set, keyed by namespace.
//
// Mirrors the skill-seed reconcile shape (apps/engine/src/skills/seed.ts):
//   - per-tenant loop over every tenant row,
//   - idempotent: a re-run with unchanged config writes nothing and lands
//     NO audit row (createMcpServer / updateMcpServer audit only on real
//     INSERT / field change),
//   - per-tenant AND per-decl error isolation: a single failing decl (or a
//     failing tenant) is logged, counted as `failed`, and skipped — it never
//     aborts the rest of the reconcile,
//   - outcome tally of inserted / updated / unchanged / failed.
//
// Boot writes use the system actor convention: `actor_id: null` +
// `request_source: "scheduler"` (the non-HTTP/system entry-point source,
// matching the scheduler reconciler's boot-time writes).
//
// Secret-by-reference: a config-declared server carries only its non-secret
// auth shape — `{ kind }` plus the oauth2 discovery fields (issuer/client_id/
// scope). The secret itself lives in the `credentials` table keyed by
// mcp_server_id (written by the CLI/route, or backed by an env-injected
// secret); it never appears in config. Inline secrets can never reach here —
// the config `McpServerDeclSchema` is `.strict()`, so any inline secret key
// fails config parse long before this runs. A config-declared bearer/oauth2
// server with no usable secret fails handshake and parks downstream.

import { getConfig } from "../config/loader.ts";
import type { McpServerDecl } from "../config/schema.ts";
import type { Db } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import {
  createMcpServer,
  getMcpServerByNamespace,
  type McpServerAuditCtx,
  type McpServerAuthConfig,
  type McpServerRow,
  updateMcpServer,
} from "./client/registry.ts";

export interface ReconcileMcpOutcome {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Decls (or whole tenants) skipped because a write threw. The reconcile
   *  is non-fatal per decl: a failure is logged, counted here, and the loop
   *  continues with the next decl / tenant. */
  failed: number;
}

// Boot-time system actor: no human, system-driven source.
const SEED_AUDIT_CTX: McpServerAuditCtx = {
  actor_id: null,
  request_source: "scheduler",
};

/** Map a config decl's optional `auth` block to the registry's
 *  `McpServerAuthConfig`. The decl carries only non-secret fields — `kind`
 *  plus the oauth2 discovery fields (issuer/client_id/scope); there is no
 *  `token_ref` (the secret lives in `credentials`, supplied out-of-band).
 *  Absent auth means `none`. The strict decl schema bans everything else. */
function mapAuth(auth: McpServerDecl["auth"]): McpServerAuthConfig | undefined {
  if (!auth) return undefined;
  const out: McpServerAuthConfig = { kind: auth.kind };
  if (auth.issuer !== undefined) out.issuer = auth.issuer;
  if (auth.client_id !== undefined) out.client_id = auth.client_id;
  if (auth.scope !== undefined) out.scope = auth.scope;
  return out;
}

/** Normalize an auth shape for idempotent comparison. Absent auth and an
 *  explicit `{ kind: "none" }` both mean "no auth" and must compare equal —
 *  otherwise a mixed-origin row (decl without `auth`, stored row with
 *  `auth_config: {kind:"none"}`) would fire a spurious update on every boot,
 *  breaking the "unchanged writes nothing" contract. Returns `null` for any
 *  no-secret shape, and a canonical `{kind, ...oauth2}` object otherwise.
 *  Only the config-owned non-secret fields participate (no token_ref). */
function normalizeAuth(auth: McpServerAuthConfig | null | undefined): {
  kind: "bearer" | "oauth2";
  issuer: string | null;
  client_id: string | null;
  scope: string | null;
} | null {
  if (!auth || auth.kind === "none") return null;
  return {
    kind: auth.kind,
    issuer: auth.issuer ?? null,
    client_id: auth.client_id ?? null,
    scope: auth.scope ?? null,
  };
}

/** True when an existing row already matches a decl on every config field
 *  this reconcile owns. Used to skip a no-op `updateMcpServer` (which would
 *  otherwise short-circuit internally, but checking here keeps the tally
 *  honest and avoids a redundant read-modify round-trip). */
function rowMatchesDecl(row: McpServerRow, decl: McpServerDecl): boolean {
  if (row.name !== decl.name) return false;
  if (row.transport !== decl.transport) return false;
  if (row.url !== decl.url) return false;
  const wantAuth = normalizeAuth(mapAuth(decl.auth));
  const haveAuth = normalizeAuth(row.auth_config as McpServerAuthConfig | null);
  if (wantAuth === null && haveAuth === null) return true;
  if (wantAuth === null || haveAuth === null) return false;
  return (
    wantAuth.kind === haveAuth.kind &&
    wantAuth.issuer === haveAuth.issuer &&
    wantAuth.client_id === haveAuth.client_id &&
    wantAuth.scope === haveAuth.scope
  );
}

/**
 * Reconcile every tenant's declared `mcp.servers` into the `mcp_servers`
 * table. Idempotent; non-fatal by contract (the caller swallows errors so a
 * bad decl never blocks boot). Returns the aggregate insert/update/unchanged
 * tally across all tenants.
 */
export async function reconcileMcpServersFromConfig(
  db: Db = getDb(),
): Promise<ReconcileMcpOutcome> {
  const allTenants = await db.select({ id: tenants.id }).from(tenants);
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const t of allTenants) {
    // Per-tenant isolation: a failure reading a tenant's config (or any
    // unexpected throw outside the per-decl guard) counts as one failure and
    // moves on to the next tenant rather than aborting the whole reconcile.
    let decls: ReadonlyArray<McpServerDecl>;
    try {
      decls = getConfig(t.id).mcp.servers;
    } catch (err) {
      failed++;
      logger.error({
        module: "mcp",
        action: "config_seed.tenant_failed",
        msg: "skipping tenant: failed to resolve mcp.servers config",
        tenant_id: t.id,
        ...errorFields(err),
      });
      continue;
    }

    for (const decl of decls) {
      // Per-decl isolation: one bad decl (e.g. a registry validation reject
      // for a bearer server with no usable secret, or a transient DB error)
      // is logged and counted, never aborts the remaining decls / tenants.
      try {
        const existing = await getMcpServerByNamespace(db, t.id, decl.namespace);
        const authConfig = mapAuth(decl.auth);
        if (!existing) {
          await createMcpServer(
            db,
            {
              tenant_id: t.id,
              name: decl.name,
              namespace: decl.namespace,
              transport: decl.transport,
              url: decl.url,
              ...(authConfig ? { auth_config: authConfig } : {}),
            },
            SEED_AUDIT_CTX,
          );
          inserted++;
          continue;
        }
        if (rowMatchesDecl(existing, decl)) {
          unchanged++;
          continue;
        }
        await updateMcpServer(
          db,
          t.id,
          existing.id,
          {
            name: decl.name,
            transport: decl.transport,
            url: decl.url,
            auth_config: authConfig ?? null,
          },
          SEED_AUDIT_CTX,
        );
        updated++;
      } catch (err) {
        failed++;
        logger.error({
          module: "mcp",
          action: "config_seed.decl_failed",
          msg: "skipping mcp.servers decl: reconcile write failed",
          tenant_id: t.id,
          namespace: decl.namespace,
          ...errorFields(err),
        });
      }
    }
  }

  return { inserted, updated, unchanged, failed };
}
