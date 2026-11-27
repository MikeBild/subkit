import type { ConnectorView } from "../connectors/index.ts";
import { withoutStdioServerManagedFields } from "../mcp/client/stdio-identity.ts";
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
  auth_type: string;
  driver: string;
};

export function authorityConnectorConfiguration(connector: AuthorityConnector | null | undefined) {
  return connector
    ? {
        resolved_connector_id: connector.id,
        driver: connector.driver,
        environment: connector.environment,
        auth_type: connector.auth_type,
        base_url: connector.base_url,
        dsn: connector.dsn,
        config: withoutStdioServerManagedFields(connector.config) ?? connector.config,
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
