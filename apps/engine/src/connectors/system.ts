import {
  type CredentialAuthorityMetadata,
  getCredentialAuthorityMetadata,
} from "../credentials/authority-metadata.ts";
import { getCredentialForConnector } from "../credentials/service.ts";
import type { DecryptedCredential } from "../credentials/types.ts";
import type { Executor } from "../db/client.ts";
import { listDocs as listConnectorDocs } from "../docs-ingestion/service.ts";
import { getConnectorForEnvironment } from "./service.ts";
import type { ConnectorView, DriverName, Environment } from "./types.ts";

export interface ConnectorDocumentSummary {
  id: string;
  source_type: string;
  source_uri: string;
  version: string;
  bytes_total: number;
  chunk_count: number;
  created_at: string;
}

export interface ConnectorSystem {
  getAuthorityMetadata(): Promise<CredentialAuthorityMetadata>;
  readonly id: string;
  readonly tenantId: string;
  readonly driver: DriverName;
  readonly templateVersion: number | null;
  readonly environment: Environment;
  readonly connector: ConnectorView;

  getCredentials(): Promise<{
    row: { connector_id: string; mode: string; tenant_id: string };
    value: DecryptedCredential;
  } | null>;

  getDocumentation(): Promise<ConnectorDocumentSummary[]>;
}

export async function loadConnectorSystem(
  tenant_id: string,
  connector_id: string,
  environment: Environment,
  exec?: Executor,
): Promise<ConnectorSystem | null> {
  const connector = await getConnectorForEnvironment(tenant_id, connector_id, environment, exec);
  if (!connector) return null;
  const resolvedEnv: Environment = connector.environment as Environment;

  return {
    id: connector.id,
    tenantId: tenant_id,
    driver: connector.driver,
    templateVersion: connector.template_version,
    environment: resolvedEnv,
    connector,
    getAuthorityMetadata() {
      return getCredentialAuthorityMetadata(tenant_id, connector.id, resolvedEnv, exec);
    },
    async getCredentials() {
      const resolved = await getCredentialForConnector(tenant_id, connector.id, resolvedEnv, exec);
      if (!resolved) return null;
      if (resolved.row.connector_id === null) {
        throw new Error(
          `connector facade resolved a credential row with no connector_id for connector ${connector.id}`,
        );
      }
      return {
        row: { ...resolved.row, connector_id: resolved.row.connector_id },
        value: resolved.value,
      };
    },
    async getDocumentation() {
      const rows = await listConnectorDocs({ tenant_id, connector_id: connector.id }, exec);
      return rows.map((r) => ({
        id: r.id,
        source_type: r.source_type,
        source_uri: r.source_uri,
        version: r.version,
        bytes_total: r.bytes_total,
        chunk_count: r.chunk_count,
        created_at: r.created_at,
      }));
    },
  };
}
