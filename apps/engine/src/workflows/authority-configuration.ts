import type { ConnectorView } from "../connectors/types.ts";
import { workflowJsonDigest } from "./canonical-json.ts";

type AuthorityConnector = Pick<
  ConnectorView,
  | "id"
  | "environment"
  | "base_url"
  | "dsn"
  | "config"
  | "template_slug"
  | "template_source"
  | "template_version"
  | "template_snapshot"
> & {
  // Hash the actual stored discriminator, including legacy credential modes.
  auth_type: string;
  driver: string;
};

/** Shared by human review and dispatch. Hash the connector actually loaded for
 * the request, not a later database reread that can hide an A → B → A change.
 * Operational health counters are deliberately not authorization boundaries. */
export function authorityConnectorConfiguration(connector: AuthorityConnector | null | undefined) {
  return connector
    ? {
        resolved_connector_id: connector.id,
        driver: connector.driver,
        environment: connector.environment,
        auth_type: connector.auth_type,
        base_url: connector.base_url,
        dsn: connector.dsn,
        config: connector.config,
        template_slug: connector.template_slug,
        template_source: connector.template_source,
        template_version: connector.template_version,
        template_snapshot: connector.template_snapshot,
      }
    : null;
}

export function authorityConnectorDigest(connector: AuthorityConnector | null | undefined): string {
  return workflowJsonDigest(authorityConnectorConfiguration(connector));
}
