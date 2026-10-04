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
