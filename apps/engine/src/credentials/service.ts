import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction } from "../audit/types.ts";
import type { EncryptedPayload } from "../crypto/aes-gcm.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db, Executor } from "../db/client.ts";
import { connectors, credentials, outboundConnections } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { invalidateTenantState } from "../operator/tenant-state.ts";
import { emitCredentialChange } from "../pubsub/resource-changes.ts";
import type { ConnectionAuthorityIdentity } from "./authority-metadata.ts";
import { authorityScopeSet, sameAuthorityScopes, storedScopes } from "./authority-scopes.ts";
import { readAccessToken, summarizeConnections } from "./connections/service.ts";
import type { ConnectionSummary } from "./connections/types.ts";
import {
  type CredentialUseSnapshot,
  type VerifiedProviderIdentity,
  VerifiedProviderIdentitySchema,
} from "./provider-identity.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { type CredentialPlaintext, deserializePlain, serializePlain } from "./credential-value.ts";
import { parseSignedJwtConfig, validateSignedJwtPrivateKey } from "./signed-jwt.ts";
import {
  type CredentialMode,
  credentialServesAuthType,
  type DecryptedCredential,
} from "./types.ts";

export type { CredentialPlaintext } from "./credential-value.ts";

export interface CredentialRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  mode: CredentialMode;
}

function aadFor(tenant_id: string, credential_id: string): string {
  return `credential:${tenant_id}:${credential_id}`;
}

function refreshAadFor(tenant_id: string, credential_id: string): string {
  return `credential-refresh:${tenant_id}:${credential_id}`;
}

interface UpsertCredentialInput {
  verified_identity?: VerifiedProviderIdentity | null;
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  mode: CredentialMode;
  value: CredentialPlaintext;
  oauth2_refresh_token?: string | null;
  oauth2_expires_at?: Date | null;
  oauth2_granted_scopes?: string | null;
  connection_id?: string | null;
  actor_id: string | null;
  actor?: Actor | null;
  actor_type?: import("../audit/types.ts").AuditActorType;
  source?: CredentialWriteSource;
}

type CredentialWriteSource =
  | "oauth_callback"
  | "conversation_tool"
  | "refresh_worker"
  | "http_route"
  | "cli_bootstrap"
  | "connector_promotion"
  | "credential_setup_grant"
  | "service_package_enrollment"
  | "unspecified";

export async function upsertCredential(
  input: UpsertCredentialInput,
  db: Executor,
): Promise<CredentialRow> {
  const ownerPredicate = eq(credentials.connector_id, input.connector_id);
  const row = await db.transaction(async (tx) => {
    if (input.mode === "signed_jwt") {
      if (input.value.mode !== "signed_jwt") {
        throw Object.assign(new Error("signed_jwt mode requires a signed_jwt credential value"), {
          code: "signed_jwt_credential_invalid",
        });
      }
      const [connector] = await tx
        .select({
          driver: connectors.driver,
          config: connectors.config,
          environment: connectors.environment,
        })
        .from(connectors)
        .where(
          and(eq(connectors.tenant_id, input.tenant_id), eq(connectors.id, input.connector_id)),
        )
        .limit(1);
      if (!connector) {
        throw Object.assign(new Error("connector not found for signed_jwt credential"), {
          code: "signed_jwt_connector_not_found",
        });
      }
      if (connector.driver !== "http" && connector.driver !== "graphql") {
        throw Object.assign(
          new Error("signed_jwt credentials require an HTTP or GraphQL connector"),
          {
            code: "signed_jwt_driver_invalid",
          },
        );
      }
      if (connector.environment !== input.environment) {
        throw Object.assign(
          new Error("signed_jwt credential environment must match the connector"),
          {
            code: "signed_jwt_environment_invalid",
          },
        );
      }
      const config = parseSignedJwtConfig(connector.config);
      await validateSignedJwtPrivateKey(input.value.private_key, config.algorithm);
    }
    const isClientSlot = input.mode === "oauth2_client";
    const slotPredicate = isClientSlot
      ? eq(credentials.mode, "oauth2_client")
      : ne(credentials.mode, "oauth2_client");
    const existing = await tx
      .select({
        id: credentials.id,
        mode: credentials.mode,
        ciphertext: credentials.ciphertext,
        iv: credentials.iv,
        auth_tag: credentials.auth_tag,
        oauth2_refresh_ciphertext: credentials.oauth2_refresh_ciphertext,
        oauth2_refresh_iv: credentials.oauth2_refresh_iv,
        oauth2_refresh_auth_tag: credentials.oauth2_refresh_auth_tag,
        granted_scopes: credentials.granted_scopes,
        connection_id: credentials.connection_id,
      })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, input.tenant_id),
          ownerPredicate,
          eq(credentials.environment, input.environment),
          slotPredicate,
        ),
      )
      .orderBy(desc(credentials.created_at), desc(credentials.id))
      .limit(1)
      .for("update");
    const priorId = existing[0]?.id ?? null;

    const placeholder = encryptSecret("__placeholder__");
    let id: string;
    if (priorId) {
      id = priorId;
    } else {
      const [row] = await tx
        .insert(credentials)
        .values({
          tenant_id: input.tenant_id,
          connector_id: input.connector_id,
          environment: input.environment,
          mode: input.mode,
          ciphertext: Buffer.from(placeholder.ciphertext),
          iv: Buffer.from(placeholder.iv),
          auth_tag: Buffer.from(placeholder.auth_tag),
        })
        .returning({ id: credentials.id });
      if (!row) throw new Error("credential insert returned no row");
      id = row.id;
    }
    const plain = serializePlain(input.value);
    const grantedScopes = storedScopes(
      input.oauth2_granted_scopes ??
        (input.value.mode === "oauth2" ? (input.value.scope ?? null) : null),
    );
    let authorityChanged = Boolean(priorId);
    const prior = existing[0];
    if (prior) {
      try {
        const previousPlain = decryptSecret(
          { ciphertext: prior.ciphertext, iv: prior.iv, auth_tag: prior.auth_tag },
          aadFor(input.tenant_id, id),
        );
        const previousRefresh =
          prior.oauth2_refresh_ciphertext &&
          prior.oauth2_refresh_iv &&
          prior.oauth2_refresh_auth_tag
            ? decryptSecret(
                {
                  ciphertext: prior.oauth2_refresh_ciphertext,
                  iv: prior.oauth2_refresh_iv,
                  auth_tag: prior.oauth2_refresh_auth_tag,
                },
                refreshAadFor(input.tenant_id, id),
              )
            : null;
        const nextRefresh = input.mode === "oauth2" ? input.oauth2_refresh_token || null : null;
        const previousMaterial = previousPlain === "" ? null : JSON.parse(previousPlain);
        const nextMaterial = plain === "" ? null : JSON.parse(plain);
        if (prior.mode === "oauth2" && input.mode === "oauth2") {
          previousMaterial.scope = authorityScopeSet(previousMaterial.scope ?? null);
          nextMaterial.scope = authorityScopeSet(nextMaterial.scope ?? null);
        }
        authorityChanged =
          prior.mode !== input.mode ||
          (prior.connection_id ?? null) !== (input.connection_id ?? null) ||
          !sameAuthorityScopes(prior.granted_scopes, grantedScopes) ||
          !isDeepStrictEqual(previousMaterial, nextMaterial) ||
          previousRefresh !== nextRefresh;
      } catch {
        authorityChanged = true;
      }
    }
    const payload = encryptSecret(plain, aadFor(input.tenant_id, id));
    let refreshPayload: EncryptedPayload | null = null;
    if (input.mode === "oauth2" && input.oauth2_refresh_token) {
      refreshPayload = encryptSecret(
        input.oauth2_refresh_token,
        refreshAadFor(input.tenant_id, id),
      );
    }

    await tx
      .update(credentials)
      .set({
        mode: input.mode,
        credential_generation: priorId ? sql`${credentials.credential_generation} + 1` : 1,
        verified_identity: input.verified_identity
          ? VerifiedProviderIdentitySchema.parse(input.verified_identity)
          : null,
        ciphertext: Buffer.from(payload.ciphertext),
        iv: Buffer.from(payload.iv),
        auth_tag: Buffer.from(payload.auth_tag),
        oauth2_refresh_ciphertext: refreshPayload ? Buffer.from(refreshPayload.ciphertext) : null,
        oauth2_refresh_iv: refreshPayload ? Buffer.from(refreshPayload.iv) : null,
        oauth2_refresh_auth_tag: refreshPayload ? Buffer.from(refreshPayload.auth_tag) : null,
        oauth2_expires_at: input.oauth2_expires_at ?? null,
        granted_scopes: grantedScopes,
        ...(authorityChanged
          ? { authority_revision: sql`${credentials.authority_revision} + 1` }
          : {}),
        connection_id: input.connection_id ?? null,
        updated_at: new Date(),
      })
      .where(eq(credentials.id, id));

    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...(input.actor ? auditActor(input.actor) : resolveActor(input)),
        action: priorId ? AuditAction.CREDENTIAL_UPDATED : AuditAction.CREDENTIAL_CREATED,
        resource_type: "credential",
        resource_id: id,
        result: "success",
        metadata: {
          connector_id: input.connector_id,
          environment: input.environment,
          mode: input.mode,
          source: input.source ?? "unspecified",
          authority_changed: authorityChanged,
          ...(input.connection_id ? { connection_id: input.connection_id } : {}),
        },
      },
      tx,
    );
    await emitCredentialChange(tx, input.tenant_id, input.connector_id);

    return {
      id,
      tenant_id: input.tenant_id,
      connector_id: input.connector_id,
      environment: input.environment,
      mode: input.mode,
    };
  });
  invalidateTenantState(input.tenant_id);
  return row;
}

export async function rotateOAuth2Tokens(
  input: {
    tenant_id: string;
    credential_id: string;
    expected_generation?: number;
    issuer?: string;
    access_token: string;
    verified_identity?: VerifiedProviderIdentity | null;
    token_type?: string | undefined;
    scope?: string | undefined;
    refresh_token?: string | null | undefined;
    expires_at?: Date | null | undefined;
    actor_id: string | null;
    actor?: Actor | null;
    actor_type?: import("../audit/types.ts").AuditActorType;
  },
  db: Executor,
): Promise<{
  credential_generation: number | null;
  verified_identity: VerifiedProviderIdentity | null;
}> {
  const identity = await db.transaction(async (tx) => {
    const [prior] = await tx
      .select({
        mode: credentials.mode,
        credential_generation: credentials.credential_generation,
        granted_scopes: credentials.granted_scopes,
        ciphertext: credentials.ciphertext,
        iv: credentials.iv,
        auth_tag: credentials.auth_tag,
      })
      .from(credentials)
      .where(
        and(eq(credentials.tenant_id, input.tenant_id), eq(credentials.id, input.credential_id)),
      )
      .for("update");
    if (
      input.expected_generation !== undefined &&
      prior?.credential_generation !== input.expected_generation
    )
      throw Object.assign(new Error("credential changed during refresh"), {
        code: "credential_generation_changed",
      });
    if (prior?.mode !== "oauth2") throw new Error("OAuth credential unavailable for refresh");
    const priorValue = deserializePlain(
      "oauth2",
      decryptSecret(
        {
          ciphertext: prior.ciphertext,
          iv: prior.iv,
          auth_tag: prior.auth_tag,
        },
        aadFor(input.tenant_id, input.credential_id),
      ),
    );
    if (priorValue.mode !== "oauth2") throw new Error("OAuth credential unavailable for refresh");
    if (
      input.issuer &&
      priorValue.issuer &&
      new URL(input.issuer).href !== new URL(priorValue.issuer).href
    ) {
      throw new Error("OAuth issuer changed during refresh");
    }
    const previousScope = prior.granted_scopes ?? priorValue.scope ?? null;
    const nextScope = storedScopes(input.scope ?? previousScope);
    const previousType = priorValue.token_type ?? "Bearer";
    const nextType = input.token_type ?? previousType;
    const authorityChanged =
      !sameAuthorityScopes(previousScope, nextScope) ||
      previousType.toLowerCase() !== nextType.toLowerCase();
    const payload = encryptSecret(
      JSON.stringify({
        access_token: input.access_token,
        issuer: priorValue.issuer ?? input.issuer,
        token_type: nextType,
        ...(nextScope === null ? {} : { scope: nextScope }),
      }),
      aadFor(input.tenant_id, input.credential_id),
    );
    const refreshPayload = input.refresh_token
      ? encryptSecret(input.refresh_token, refreshAadFor(input.tenant_id, input.credential_id))
      : null;
    const updated = await tx
      .update(credentials)
      .set({
        credential_generation: sql`${credentials.credential_generation} + 1`,
        verified_identity: input.verified_identity
          ? VerifiedProviderIdentitySchema.parse(input.verified_identity)
          : null,
        ciphertext: Buffer.from(payload.ciphertext),
        iv: Buffer.from(payload.iv),
        auth_tag: Buffer.from(payload.auth_tag),
        ...(refreshPayload
          ? {
              oauth2_refresh_ciphertext: Buffer.from(refreshPayload.ciphertext),
              oauth2_refresh_iv: Buffer.from(refreshPayload.iv),
              oauth2_refresh_auth_tag: Buffer.from(refreshPayload.auth_tag),
            }
          : {}),
        granted_scopes: nextScope,
        ...(authorityChanged
          ? { authority_revision: sql`${credentials.authority_revision} + 1` }
          : {}),
        oauth2_expires_at: input.expires_at ?? null,
        updated_at: new Date(),
      })
      .where(
        and(eq(credentials.tenant_id, input.tenant_id), eq(credentials.id, input.credential_id)),
      )
      .returning({
        credential_generation: credentials.credential_generation,
        verified_identity: credentials.verified_identity,
      });
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...(input.actor ? auditActor(input.actor) : resolveActor(input)),
        action: AuditAction.CREDENTIAL_ROTATED,
        resource_type: "credential",
        resource_id: input.credential_id,
        result: "success",
        metadata: { reason: "oauth2_refresh", authority_changed: authorityChanged },
      },
      tx,
    );
    return updated[0] ?? { credential_generation: null, verified_identity: null };
  });

  logger.info({
    module: "credentials",
    action: "credential.rotated",
    msg: "oauth2 credential rotated",
    credential_id: input.credential_id,
    tenant_id: input.tenant_id,
    expires_at: input.expires_at?.toISOString() ?? null,
  });
  return identity;
}

export async function getCredentialForConnector(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  db: Executor,
): Promise<{
  row: typeof credentials.$inferSelect;
  value: DecryptedCredential;
  connection_authority?: ConnectionAuthorityIdentity | null;
  credential_snapshot?: CredentialUseSnapshot;
} | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        eq(credentials.environment, environment),
        ne(credentials.mode, "oauth2_client"),
        isNull(credentials.deleted_at),
      ),
    )
    .orderBy(desc(credentials.created_at), desc(credentials.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.connection_id) {
    const grant = await readAccessToken(db as Db, tenant_id, row.connection_id);
    return {
      row,
      connection_authority: grant?.connection_authority ?? null,
      credential_snapshot: {
        connector_id,
        environment,
        credential_id: row.id,
        credential_generation: row.credential_generation,
        connection_id: row.connection_id,
        access_token_version: grant?.access_token_version ?? null,
        identity: grant?.verified_identity ?? null,
      },
      value: {
        mode: "oauth2",
        access_token: grant?.access_token ?? "",
        ...(grant?.issuer ? { issuer: grant.issuer } : {}),
        token_type: "Bearer",
        refresh_token: null,
        expires_at: grant?.expires_at ?? null,
      },
    };
  }
  const plain = decryptSecret(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      auth_tag: row.auth_tag,
    },
    aadFor(tenant_id, row.id),
  );
  const value = deserializePlain(row.mode as CredentialMode, plain);
  if (
    value.mode === "oauth2" &&
    row.oauth2_refresh_ciphertext &&
    row.oauth2_refresh_iv &&
    row.oauth2_refresh_auth_tag
  ) {
    const refresh = decryptSecret(
      {
        ciphertext: row.oauth2_refresh_ciphertext,
        iv: row.oauth2_refresh_iv,
        auth_tag: row.oauth2_refresh_auth_tag,
      },
      refreshAadFor(tenant_id, row.id),
    );
    value.refresh_token = refresh;
    value.expires_at = row.oauth2_expires_at ?? null;
  }
  if (value.mode === "oauth2" && value.expires_at === null && row.oauth2_expires_at) {
    value.expires_at = row.oauth2_expires_at;
  }
  return { row, value };
}

function authenticatingCredentials(tenant_id: string, connector_ids: readonly string[]) {
  return and(
    eq(credentials.tenant_id, tenant_id),
    inArray(credentials.connector_id, [...connector_ids]),
    ne(credentials.mode, "oauth2_client"),
  );
}

export interface ConnectorCredentialState {
  mode: string;
  connection: ConnectionSummary | null;
}

export async function describeConnectorCredentialStates(
  tenant_id: string,
  targets: readonly { id: string; environment: string; auth_type: string }[],
  db: Executor,
): Promise<Map<string, ConnectorCredentialState | null>> {
  const found = new Map<string, ConnectorCredentialState | null>();
  const ids = targets.map((target) => target.id).filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return found;
  const rows = await db
    .select({
      connector_id: credentials.connector_id,
      environment: credentials.environment,
      mode: credentials.mode,
      connection_id: credentials.connection_id,
    })
    .from(credentials)
    .where(authenticatingCredentials(tenant_id, ids))
    .orderBy(desc(credentials.created_at), desc(credentials.id));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.connector_id}:${row.environment}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const connections = await summarizeConnections(
    db,
    tenant_id,
    [...latest.values()].flatMap((row) => (row.connection_id ? [row.connection_id] : [])),
  );
  for (const target of targets) {
    const row = latest.get(`${target.id}:${target.environment}`);
    const mode = row ? (row.connection_id ? "connection" : row.mode) : null;
    found.set(
      target.id,
      row && mode && credentialServesAuthType(target.auth_type, mode)
        ? {
            mode,
            connection: row.connection_id ? (connections.get(row.connection_id) ?? null) : null,
          }
        : null,
    );
  }
  return found;
}

export async function describeCredentialForConnector(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  db: Executor,
): Promise<{
  speaks_as: VerifiedProviderIdentity | null;
  mode: string;
  environment: "dev" | "prod";
  connection: ConnectionSummary | null;
  header_names: string[];
  updated_at: string;
} | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const rows = await db
    .select({
      id: credentials.id,
      verified_identity: credentials.verified_identity,
      mode: credentials.mode,
      environment: credentials.environment,
      updated_at: credentials.updated_at,
      connection_id: credentials.connection_id,
      ciphertext: credentials.ciphertext,
      iv: credentials.iv,
      auth_tag: credentials.auth_tag,
    })
    .from(credentials)
    .where(
      and(
        authenticatingCredentials(tenant_id, [connector_id]),
        eq(credentials.environment, environment),
      ),
    )
    .orderBy(desc(credentials.created_at), desc(credentials.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const connection = row.connection_id
    ? ((await summarizeConnections(db, tenant_id, [row.connection_id])).get(row.connection_id) ??
      null)
    : null;
  const [boundIdentity] = row.connection_id
    ? await db
        .select({ identity: outboundConnections.verified_identity })
        .from(outboundConnections)
        .where(
          and(
            eq(outboundConnections.tenant_id, tenant_id),
            eq(outboundConnections.id, row.connection_id),
          ),
        )
        .limit(1)
    : [];
  return {
    speaks_as: row.connection_id ? (boundIdentity?.identity ?? null) : row.verified_identity,
    mode: row.connection_id ? "connection" : row.mode,
    environment: row.environment,
    connection,
    header_names: row.connection_id ? [] : headerNamesOf(tenant_id, row),
    updated_at: row.updated_at.toISOString(),
  };
}

function headerNamesOf(
  tenant_id: string,
  row: { id: string; mode: string; ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array },
): string[] {
  if (row.mode !== "header") return [];
  const plain = decryptSecret(row, aadFor(tenant_id, row.id));
  const value = deserializePlain("header", plain);
  return value.mode === "header" ? Object.keys(value.headers).sort() : [];
}

export async function getOAuth2ClientCredential(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  db: Executor,
): Promise<{
  client_id: string;
  issuer?: string;
  client_secret: string | undefined;
  credential_snapshot: CredentialUseSnapshot;
} | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        eq(credentials.environment, environment),
        eq(credentials.mode, "oauth2_client"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const plain = decryptSecret(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      auth_tag: row.auth_tag,
    },
    aadFor(tenant_id, row.id),
  );
  const value = deserializePlain("oauth2_client", plain);
  if (value.mode !== "oauth2_client") return null;
  return {
    client_id: value.client_id,
    ...(value.issuer ? { issuer: value.issuer } : {}),
    client_secret: value.client_secret,
    credential_snapshot: {
      connector_id,
      environment,
      credential_id: row.id,
      credential_generation: row.credential_generation,
      connection_id: null,
      access_token_version: null,
      identity: row.verified_identity,
    },
  };
}

export async function resolveDefaultEnvironmentForConnector(
  tenant_id: string,
  connector_id: string,
  db: Executor,
): Promise<"dev" | "prod" | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const rows = await db
    .select({ environment: credentials.environment })
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        ne(credentials.mode, "oauth2_client"),
        inArray(credentials.environment, ["dev", "prod"]),
      ),
    )
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.some((r) => r.environment === "dev")) return "dev";
  return "prod";
}

export async function resolveDryRunEnvironment(p: {
  tenant_id: string;
  steps: unknown[];
  requested?: "dev" | "prod" | undefined;
  exec: Executor;
  conversation_id?: string | undefined;
  onLog?: ((level: "debug" | "info" | "warn" | "error", message: string) => void) | undefined;
}): Promise<"dev" | "prod"> {
  if (p.requested !== undefined) return p.requested;
  const connectorIds = [
    ...new Set(
      p.steps
        .map((s) => (s as { connector_id?: unknown }).connector_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (connectorIds.length === 0) return "dev";
  const uuidIds = connectorIds.filter((id) => UUID_RE.test(id));
  const authRows = uuidIds.length
    ? await p.exec
        .select({ id: connectors.id, auth_type: connectors.auth_type })
        .from(connectors)
        .where(and(eq(connectors.tenant_id, p.tenant_id), inArray(connectors.id, uuidIds)))
    : [];
  const keyless = new Set(authRows.filter((r) => r.auth_type === "none").map((r) => r.id));
  const authRequiringIds = connectorIds.filter((id) => !keyless.has(id));
  if (authRequiringIds.length === 0) return "dev";

  const envResults = await Promise.all(
    authRequiringIds.map((id) =>
      resolveDefaultEnvironmentForConnector(p.tenant_id, id, p.exec).catch(() => null),
    ),
  );
  const resolvedEnvs = envResults.filter((e): e is "dev" | "prod" => e !== null);
  if (resolvedEnvs.length === 0) {
    logger.warn({
      module: "conversation_tool",
      action: "dry_run_workflow.no_credential_found",
      msg: "none of the draft's auth-requiring connector(s) have a credential in any environment; defaulting to dev — the run may fail with 401/404",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      connector_ids: authRequiringIds,
    });
    p.onLog?.(
      "warn",
      `no credential found for connector(s) [${authRequiringIds.join(", ")}] in dev or prod — the run may fail with 401/404`,
    );
    return "dev";
  }
  return resolvedEnvs.includes("dev") ? "dev" : "prod";
}

export async function getOAuth2PrivateKeyCredential(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  db: Executor,
): Promise<{
  client_id: string;
  private_key: string;
  algorithm: string;
  credential_snapshot: CredentialUseSnapshot;
} | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        eq(credentials.environment, environment),
        eq(credentials.mode, "oauth2_private_key"),
      ),
    )
    .orderBy(desc(credentials.created_at), desc(credentials.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const plain = decryptSecret(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      auth_tag: row.auth_tag,
    },
    aadFor(tenant_id, row.id),
  );
  const value = deserializePlain("oauth2_private_key", plain);
  if (value.mode !== "oauth2_private_key") return null;
  return {
    client_id: value.client_id,
    private_key: value.private_key,
    algorithm: value.algorithm,
    credential_snapshot: {
      connector_id,
      environment,
      credential_id: row.id,
      credential_generation: row.credential_generation,
      connection_id: null,
      access_token_version: null,
      identity: row.verified_identity,
    },
  };
}

export async function recordCredentialProviderIdentity(
  input: {
    tenant_id: string;
    snapshot: CredentialUseSnapshot;
    identity: VerifiedProviderIdentity | null;
    request_source: import("../observability/service-metadata.ts").RequestSource;
  },
  db: Executor,
): Promise<void> {
  const credentialId = input.snapshot.credential_id;
  const generation = input.snapshot.credential_generation;
  if (!credentialId || generation === null) return;
  const identity = input.identity ? VerifiedProviderIdentitySchema.parse(input.identity) : null;
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(credentials)
      .set({ verified_identity: identity })
      .where(
        and(
          eq(credentials.tenant_id, input.tenant_id),
          eq(credentials.id, credentialId),
          eq(credentials.connector_id, input.snapshot.connector_id),
          eq(credentials.environment, input.snapshot.environment),
          eq(credentials.credential_generation, generation),
          inArray(credentials.mode, ["oauth2_client", "oauth2_private_key"]),
          sql`${credentials.verified_identity} IS DISTINCT FROM ${identity ? JSON.stringify(identity) : null}::jsonb`,
        ),
      )
      .returning({ id: credentials.id });
    const row = rows[0];
    if (!row) return;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.CREDENTIAL_UPDATED,
        resource_type: "credential",
        resource_id: row.id,
        result: "success",
        metadata: { reason: "provider_identity_observed", request_source: input.request_source },
      },
      tx,
    );
  });
}

export async function credentialExists(
  db: Executor,
  tenant_id: string,
  credential_id: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.id, credential_id)))
    .limit(1);
  return rows.length > 0;
}

export async function findLiveCredential(
  db: Executor,
  tenant_id: string,
  credential_id: string,
): Promise<typeof credentials.$inferSelect | null> {
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.id, credential_id),
        isNull(credentials.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteCredential(
  tenant_id: string,
  credential_id: string,
  actor_input: string | Actor | null,
  db: Executor,
): Promise<boolean> {
  const deleted = await db
    .delete(credentials)
    .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.id, credential_id)))
    .returning({ connector_id: credentials.connector_id });
  const ok = deleted.length > 0;
  if (ok) {
    invalidateTenantState(tenant_id);
    await emitCredentialChange(db, tenant_id, deleted[0]?.connector_id);
    await auditAwait(
      {
        tenant_id,
        ...(typeof actor_input === "string"
          ? resolveActor({ tenant_id, actor_id: actor_input })
          : actor_input
            ? auditActor(actor_input)
            : resolveActor({ tenant_id, actor_id: null })),
        action: AuditAction.CREDENTIAL_DELETED,
        resource_type: "credential",
        resource_id: credential_id,
        result: "success",
        metadata: {},
      },
      db,
    );
  }
  return ok;
}
