// Reuse-by-URL short-circuit shared by all `start_connector_*` /
// `import_connector_from_spec` paths.
//
// When the operator hands the engine a `base_url` that already maps to
// a saved connector in the same environment, surface the existing row
// instead of minting a new draft. Without this, two starts against the
// same upstream URL produce two saved connectors, splitting the
// conversation's working credential across two rows. Reuse is keyed on
// `(tenant_id, base_url, environment)` plus an optional driver filter.

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
  "An existing saved connector matches this URL. Reuse it (its credentials are already encrypted and the schema is already discovered). To make changes, call update_connector_draft against this connector_id, OR explicitly pass a different `name` to the start_* tool if you really want a separate connector.";

export async function findReusableConnectorByUrl(p: {
  tenant_id: string;
  environment: "dev" | "prod";
  base_url: string | undefined;
  driver?: string | undefined;
  db: Db;
}): Promise<ReusedConnectorEnvelope | null> {
  if (!p.base_url) return null;
  const existing = await listConnectors(p.tenant_id, { environment: p.environment }, p.db);
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
