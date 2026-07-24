// Reuse-by-URL short-circuit shared by all `start_connector_*` /
// `import_connector_from_spec` paths.
//
// When the operator hands the engine a `base_url` that already maps to
// a saved connector in the same environment, surface the existing row
// instead of minting a new draft. Without this, re-describing the same
// upstream (the LLM often picks a slightly different display name) would
// fork a fresh, credential-less draft and force the operator to re-type
// the secret. Reuse is keyed on `(tenant_id, base_url, environment)` plus
// an optional driver filter — a differing NAME is NOT a reason to skip
// reuse (that is the normal re-describe case; see session 1b94070c).
//
// The deliberate escape hatch is `force_new`: an operator who wants a
// SEPARATE, scope-isolated connector on a shared upstream (e.g. a
// read/write key alongside an admin key) sets it, and the caller starts a
// fresh draft instead of being trapped on the existing row. Matching the
// URL alone previously left no way to express that — every second
// connector on a shared base URL collapsed onto the first.

import { listConnectors } from "../../connectors/service.ts";
import type { Db } from "../../db/client.ts";

export interface ReusedConnector {
  id: string;
  name: string;
  slug: string;
  driver: string;
  environment: "dev" | "prod";
  auth_type: string;
  base_url: string | null;
  template_slug: string | null;
  template_name: string | null;
}

export interface ReusedConnectorEnvelope {
  resource_kind: "connector";
  reused_existing: true;
  connector: ReusedConnector;
  advice: string;
}

const REUSE_ADVICE =
  "An existing saved connector matches this URL. Reuse it (its credentials are already encrypted and the schema is already discovered) — to make changes, call update_connector_draft against this connector_id. If the operator explicitly wants a SEPARATE connector on this same URL (e.g. a different credential scope), call the same start_* tool again with `force_new: true` to mint an independent draft.";

export async function findReusableConnectorByUrl(p: {
  tenant_id: string;
  environment: "dev" | "prod";
  base_url: string | undefined;
  driver?: string | undefined;
  /**
   * When true, the operator has explicitly asked for a SEPARATE connector
   * on this base URL — skip reuse entirely so the caller starts a fresh,
   * independently-credentialed draft. A differing connector NAME does NOT
   * imply this; only this explicit flag does.
   */
  force_new?: boolean | undefined;
  db: Db;
}): Promise<ReusedConnectorEnvelope | null> {
  if (!p.base_url) return null;
  if (p.force_new) return null;
  const { rows: existing } = await listConnectors(
    p.tenant_id,
    { environment: p.environment },
    p.db,
  );
  const reuse = existing.find(
    (c) => c.base_url === p.base_url && (!p.driver || c.driver === p.driver),
  );
  if (!reuse) return null;
  return {
    resource_kind: "connector",
    reused_existing: true,
    connector: {
      id: reuse.id,
      name: reuse.display_name,
      slug: reuse.slug,
      driver: reuse.driver,
      environment: reuse.environment,
      auth_type: reuse.auth_type,
      base_url: reuse.base_url,
      template_slug: reuse.template_slug ?? null,
      template_name: reuse.template_name ?? null,
    },
    advice: REUSE_ADVICE,
  };
}
