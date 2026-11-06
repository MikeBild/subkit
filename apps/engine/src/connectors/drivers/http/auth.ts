import { refreshIfStale } from "../../../credentials/oauth2/refresh-worker.ts";
import { getCredentialForConnector } from "../../../credentials/service.ts";
import { parseSignedJwtConfig, signJwtBearer } from "../../../credentials/signed-jwt.ts";
import { refreshTokenMintIfStale } from "../../../credentials/token-mint/refresh-worker.ts";
import type { DecryptedCredential } from "../../../credentials/types.ts";
import type { Db } from "../../../db/client.ts";
import type { ConnectorView } from "../../types.ts";
import type { HttpExecutionResult, ResolvedConnectorCredential } from "./types.ts";

function credentialless(credential: DecryptedCredential | null): ResolvedConnectorCredential {
  return {
    credential,
    credential_id: null,
    credential_revision: null,
    oauth2_refreshed: false,
  };
}

export async function resolveConnectorCredential(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  override?: DecryptedCredential | null;
}): Promise<ResolvedConnectorCredential> {
  if (p.override !== undefined) {
    return credentialless(p.override);
  }
  if (p.connector.auth_type === "none") {
    return credentialless(null);
  }
  const row = await getCredentialForConnector(
    p.tenant_id,
    p.connector.id,
    p.connector.environment,
    p.db,
  );
  if (!row) {
    return credentialless(null);
  }
  let credential: DecryptedCredential = row.value;
  let oauth2_refreshed = false;
  if (credential.mode === "oauth2") {
    const preToken = credential.access_token;
    credential = await refreshIfStale(p.db, p.tenant_id, row.row, credential);
    if (credential.mode === "oauth2" && credential.access_token !== preToken) {
      oauth2_refreshed = true;
    }
  } else if (credential.mode === "token_mint") {
    const preToken = credential.access_token;
    credential = await refreshTokenMintIfStale(p.db, p.tenant_id, row.row, credential);
    oauth2_refreshed = credential.mode === "token_mint" && credential.access_token !== preToken;
  }
  return {
    credential,
    credential_id: row.row.id,
    credential_revision: row.row.authority_revision,
    credential_snapshot: row.credential_snapshot ?? {
      connector_id: p.connector.id,
      environment: p.connector.environment,
      credential_id: row.row.id,
      credential_generation: row.row.credential_generation,
      connection_id: null,
      access_token_version: null,
      identity: row.row.verified_identity,
    },
    connection_authority: row.connection_authority ?? null,
    oauth2_refreshed,
  };
}

export async function applySignedJwtAuth(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
  url: URL,
  headers: Record<string, string>,
): Promise<string | null> {
  if (credential?.mode !== "signed_jwt") return null;
  const base = connector.base_url ? new URL(connector.base_url) : null;
  if (!base || base.origin !== url.origin) {
    throw Object.assign(new Error("signed_jwt requests must stay on the connector origin"), {
      code: "signed_jwt_origin_invalid",
    });
  }
  const token = await signJwtBearer({
    private_key: credential.private_key,
    config: parseSignedJwtConfig(connector.config ?? {}),
  });
  headers.Authorization = `Bearer ${token}`;
  return token;
}

export function redactSignedJwtValue(value: unknown, token: string): unknown {
  if (typeof value === "string") return value.replaceAll(token, "[REDACTED]");
  if (Buffer.isBuffer(value)) {
    const source = Buffer.from(token, "utf8");
    const out = Buffer.from(value);
    let index = out.indexOf(source);
    while (index >= 0) {
      out.fill(0x2a, index, index + source.length);
      index = out.indexOf(source, index + source.length);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSignedJwtValue(entry, token));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replaceAll(token, "[REDACTED]"),
        redactSignedJwtValue(entry, token),
      ]),
    );
  }
  return value;
}

export function redactSignedJwtResponse(
  result: HttpExecutionResult,
  token: string | null,
): HttpExecutionResult {
  if (!token) return result;
  return {
    ...result,
    headers: redactSignedJwtValue(result.headers, token) as Record<string, string>,
    body: redactSignedJwtValue(result.body, token),
    ...(result.body_raw
      ? { body_raw: redactSignedJwtValue(result.body_raw, token) as Buffer }
      : {}),
  };
}
