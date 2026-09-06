// Authority preparation reads identities and permissions, never token material.
// In particular, it must not call readAccessToken/getCredentialForConnector,
// whose connection-backed path can refresh against a remote authorization server.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { credentials, outboundConnections, runtimeSecretVersions } from "../db/schema/index.ts";
import { authorityScopeSet } from "./authority-scopes.ts";
import { secretNames } from "./connections/service.ts";

export interface CredentialAuthorityMetadata {
  binding: {
    primary: {
      id: string;
      revision: number;
      mode: string;
      scopes: string[] | null;
      connection_id: string | null;
    } | null;
    client: { id: string; revision: number } | null;
    connection: {
      id: string;
      revision: number;
      base_url: string;
      issuer: string;
      client_id: string;
      scopes: string[] | null;
      granted_scopes: string[] | null;
    } | null;
  };
  // Availability is evaluated separately from the stable binding. Expiry or a
  // failed refresh must not make a token version part of the identity digest.
  available: boolean;
}

export async function getCredentialAuthorityMetadata(
  tenantId: string,
  connectorId: string,
  environment: "dev" | "prod",
  db: Executor = getDb(),
): Promise<CredentialAuthorityMetadata> {
  const rows = await db
    .select({
      id: credentials.id,
      revision: credentials.authority_revision,
      mode: credentials.mode,
      scopes: credentials.granted_scopes,
      connection_id: credentials.connection_id,
      usable: sql<boolean>`(${credentials.mode} <> 'oauth2' OR ${credentials.oauth2_expires_at} IS NULL
      OR ${credentials.oauth2_expires_at} > clock_timestamp() OR ${credentials.oauth2_refresh_ciphertext} IS NOT NULL)`,
    })
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenantId),
        eq(credentials.connector_id, connectorId),
        eq(credentials.environment, environment),
        isNull(credentials.deleted_at),
      ),
    )
    .orderBy(desc(credentials.created_at), desc(credentials.id));
  const primary = rows.find((row) => row.mode !== "oauth2_client");
  const client = rows.find((row) => row.mode === "oauth2_client");
  const result: CredentialAuthorityMetadata = {
    binding: {
      primary: primary
        ? {
            id: primary.id,
            revision: primary.revision,
            mode: primary.mode,
            scopes: authorityScopeSet(primary.scopes),
            connection_id: primary.connection_id,
          }
        : null,
      client: client ? { id: client.id, revision: client.revision } : null,
      connection: null,
    },
    available: primary?.usable ?? false,
  };
  if (!primary?.connection_id) return result;
  const [connection] = await db
    .select({
      id: outboundConnections.id,
      revision: outboundConnections.authority_revision,
      name: outboundConnections.name,
      base_url: outboundConnections.base_url,
      issuer: outboundConnections.issuer,
      client_id: outboundConnections.client_id,
      scopes: outboundConnections.scopes,
      granted_scopes: outboundConnections.granted_scopes,
      access_version: outboundConnections.access_token_version,
      usable: sql<boolean>`(${outboundConnections.refresh_failed_at} IS NULL AND
      (${outboundConnections.expires_at} IS NULL OR ${outboundConnections.expires_at} > clock_timestamp()
      OR ${outboundConnections.refresh_token_version} IS NOT NULL))`,
    })
    .from(outboundConnections)
    .where(
      and(
        eq(outboundConnections.tenant_id, tenantId),
        eq(outboundConnections.id, primary.connection_id),
      ),
    )
    .limit(1);
  result.available = false;
  if (!connection) return result;
  result.binding.connection = {
    id: connection.id,
    revision: connection.revision,
    base_url: connection.base_url,
    issuer: connection.issuer,
    client_id: connection.client_id,
    scopes: authorityScopeSet(connection.scopes.join(" ")),
    granted_scopes: authorityScopeSet(connection.granted_scopes?.join(" ") ?? null),
  };
  const [token] = await db
    .select({ usable: sql<boolean>`${runtimeSecretVersions.revoked_at} IS NULL` })
    .from(runtimeSecretVersions)
    .where(
      and(
        eq(runtimeSecretVersions.name, secretNames(tenantId, connection.name).access),
        eq(runtimeSecretVersions.version, connection.access_version),
      ),
    )
    .limit(1);
  result.available = connection.usable && (token?.usable ?? false);
  return result;
}
