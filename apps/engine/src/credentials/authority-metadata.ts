import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
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
  available: boolean;
}

export interface ConnectionAuthorityIdentity {
  id: string;
  revision: number;
}

export interface CredentialAuthorityRequest {
  connector_id: string;
  environment: "dev" | "prod";
}

export function credentialAuthorityKey(connector_id: string, environment: "dev" | "prod"): string {
  return `${connector_id}:${environment}`;
}

export async function getCredentialAuthorityMetadataBatch(
  tenantId: string,
  requests: readonly CredentialAuthorityRequest[],
  db: Executor,
): Promise<Map<string, CredentialAuthorityMetadata>> {
  const result = new Map<string, CredentialAuthorityMetadata>();
  if (requests.length === 0) return result;
  const rows = await db
    .select({
      connector_id: credentials.connector_id,
      environment: credentials.environment,
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
        inArray(credentials.connector_id, [
          ...new Set(requests.map((request) => request.connector_id)),
        ]),
        inArray(credentials.environment, [
          ...new Set(requests.map((request) => request.environment)),
        ]),
        isNull(credentials.deleted_at),
      ),
    )
    .orderBy(desc(credentials.created_at), desc(credentials.id));
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.connector_id === null) continue;
    const key = `${row.connector_id}:${row.environment}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const connectionIds = new Set<string>();
  for (const request of requests) {
    const key = credentialAuthorityKey(request.connector_id, request.environment);
    const group = grouped.get(key) ?? [];
    const primary = group.find((row) => row.mode !== "oauth2_client");
    const client = group.find((row) => row.mode === "oauth2_client");
    result.set(key, {
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
      available: primary?.connection_id ? false : (primary?.usable ?? false),
    });
    if (primary?.connection_id) connectionIds.add(primary.connection_id);
  }
  if (connectionIds.size === 0) return result;
  const connections = await db
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
        inArray(outboundConnections.id, [...connectionIds]),
      ),
    );
  const tokens =
    connections.length === 0
      ? []
      : await db
          .select({
            name: runtimeSecretVersions.name,
            version: runtimeSecretVersions.version,
            usable: sql<boolean>`${runtimeSecretVersions.revoked_at} IS NULL`,
          })
          .from(runtimeSecretVersions)
          .where(
            or(
              ...connections.map((connection) =>
                and(
                  eq(runtimeSecretVersions.name, secretNames(tenantId, connection.name).access),
                  eq(runtimeSecretVersions.version, connection.access_version),
                ),
              ),
            ),
          );
  const tokenUsability = new Map(
    tokens.map((token) => [JSON.stringify([token.name, token.version]), token.usable]),
  );
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  for (const metadata of result.values()) {
    const id = metadata.binding.primary?.connection_id;
    const connection = id ? byId.get(id) : undefined;
    if (!connection) continue;
    metadata.binding.connection = {
      id: connection.id,
      revision: connection.revision,
      base_url: connection.base_url,
      issuer: connection.issuer,
      client_id: connection.client_id,
      scopes: authorityScopeSet(connection.scopes.join(" ")),
      granted_scopes: authorityScopeSet(connection.granted_scopes?.join(" ") ?? null),
    };
    metadata.available =
      connection.usable &&
      (tokenUsability.get(
        JSON.stringify([secretNames(tenantId, connection.name).access, connection.access_version]),
      ) ??
        false);
  }
  return result;
}

export async function getCredentialAuthorityMetadata(
  tenantId: string,
  connectorId: string,
  environment: "dev" | "prod",
  db: Executor,
): Promise<CredentialAuthorityMetadata> {
  const rows = await getCredentialAuthorityMetadataBatch(
    tenantId,
    [{ connector_id: connectorId, environment }],
    db,
  );
  const metadata = rows.get(credentialAuthorityKey(connectorId, environment));
  if (!metadata) throw new Error("credential authority metadata missing from requested batch");
  return metadata;
}
