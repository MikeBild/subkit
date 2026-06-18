// `ConnectorSystem` — single facade unifying connector + driver +
// credentials + docs. Mirrors the reference impl's `SystemManager`
// interface (`packages/core/systems/system-manager.ts`) so cross-
// codebase mental model is consistent. Subkit-specific extensions:
// `tenantId` and `schemaVersion` make tenant isolation and self-healing
// drift tracking part of the type, not callable invariants.
//
// Use this for any code path that needs MORE THAN ONE of {driver,
// credentials, documentation}. Single-purpose call sites (an OAuth
// refresh worker that only needs creds) can keep calling
// `getCredentialForConnector` directly; the facade is for orchestrators
// (conversation tools, execution steps) where the three are entangled.

import { getCredentialForConnector } from "../credentials/service.ts";
import type { DecryptedCredential } from "../credentials/types.ts";
import type { Db } from "../db/client.ts";
import { listDocs as listConnectorDocs } from "../docs-ingestion/service.ts";
import { getConnectorForEnvironment } from "./service.ts";
import type { ConnectorView, DriverName, Environment } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
  /** The connector row id this facade is bound to. */
  readonly id: string;
  /** Tenant scope — every credential / doc lookup is filtered by this. */
  readonly tenantId: string;
  /** Driver name — `"http"`, `"graphql"`, `"postgres"`, … */
  readonly driver: DriverName;
  /**
   * Template-version pin from the connector row. Self-healing's
   * drift detector tracks per-endpoint shapes against this in the
   * `schema_versions` table; the field exposes the pin so consumers
   * can correlate facade output with drift records.
   */
  readonly templateVersion: number | null;
  /** Resolved environment (`"dev"` | `"prod"`). */
  readonly environment: Environment;
  /** The underlying connector row. */
  readonly connector: ConnectorView;

  /**
   * Resolve credentials for this connector's environment. Returns
   * `null` if no credential row exists (e.g. probe before auth was
   * configured). Callers that require credentials should treat `null`
   * as a typed error; the facade does not throw.
   *
   * RBAC pre-check is the caller's responsibility (the engine's
   * `before-request hook` runs at request time, not here). The facade
   * is purely a lookup — it does not reach into the policy layer.
   */
  getCredentials(): Promise<{
    // `connector_id` is nullable on the shared credentials row (an MCP
    // server may own a row instead), but this facade ONLY ever
    // resolves connector-owned rows via `getCredentialForConnector`. We
    // re-narrow to non-null at the facade boundary (fail-fast in the impl
    // if the resolved row ever lacks a connector_id) so callers never see
    // the MCP-widened type.
    row: { connector_id: string; mode: string; tenant_id: string };
    value: DecryptedCredential;
  } | null>;

  /**
   * List the connector's ingested documents (OpenAPI / GraphQL schema /
   * markdown). Used by conversation tools that need to surface the
   * connector's spec to the LLM. Returns `[]` for connectors with no
   * ingestion configured.
   */
  getDocumentation(): Promise<ConnectorDocumentSummary[]>;
}

/**
 * Load the facade for a connector. Resolves the connector row once
 * (with the environment fall-back from `getConnectorForEnvironment`)
 * and lazily defers credential + docs lookups to first use — the
 * caller may only need one of them.
 */
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
    async getCredentials() {
      const resolved = await getCredentialForConnector(tenant_id, connector.id, resolvedEnv, exec);
      if (!resolved) return null;
      // Re-narrow connector_id at the facade: this lookup only ever returns
      // connector-owned rows, so a null connector_id is a contract
      // violation (an MCP-owned row leaked through the connector resolver).
      // Fail fast rather than hand back a non-connector row typed as one.
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
