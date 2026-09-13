// Credential CRUD — every write encrypts with the AES-256-GCM helper,
// every read decrypts. AAD binds a ciphertext to `tenant_id:credential_id`
// so a blob lifted from one row can't be replayed into another.
//
// For non-oauth2 modes the plaintext is a JSON object serialized to a
// UTF-8 string. For oauth2 the access token lives in the primary
// ciphertext triple and the refresh token (if any) lives in the sibling
// `oauth2_refresh_*` triple.
//
// Every mutation writes an audit row.

import { isDeepStrictEqual } from "node:util";

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { EncryptedPayload } from "../crypto/aes-gcm.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { connectors, credentials, outboundConnections } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import {
  hasCredentialAuthorityRevisionColumn,
  hasCredentialConnectionColumn,
} from "../runtime-config/secret-columns.ts";
import type { ConnectionAuthorityIdentity } from "./authority-metadata.ts";
import { authorityScopeSet, sameAuthorityScopes } from "./authority-scopes.ts";
import { readAccessToken } from "./connections/service.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import type {
  AwsSigV4CredentialValue,
  BasicCredentialValue,
  BearerCredentialValue,
  CredentialMode,
  DecryptedCredential,
  HeaderCredentialValue,
  OAuth2ClientCredentialValue,
  OAuth2CredentialValue,
  OAuth2PrivateKeyCredentialValue,
  QueryCredentialValue,
  TokenMintCredentialValue,
  TokenMintShape,
} from "./types.ts";

export interface CredentialRow {
  id: string;
  tenant_id: string;
  /** Owning connector. An external MCP server is a connector whose driver
   *  is `mcp`, so there is exactly one owner column. */
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

export type CredentialPlaintext =
  | { mode: "none" }
  | ({ mode: "header" } & HeaderCredentialValue)
  | ({ mode: "query" } & QueryCredentialValue)
  | ({ mode: "bearer" } & BearerCredentialValue)
  | ({ mode: "basic" } & BasicCredentialValue)
  | ({
      mode: "oauth2";
      refresh_token?: string | null;
      expires_at?: Date | null;
    } & OAuth2CredentialValue)
  | ({ mode: "aws_sigv4" } & AwsSigV4CredentialValue)
  | {
      mode: "token_mint";
      // Cached access token from the most recent mint. Empty until the
      // first mint runs.
      access_token: string;
      refresh_token?: string | null;
      expires_at?: Date | null;
      // Static mint config — encrypted at rest with the cached token.
      shape: TokenMintShape;
      mint_endpoint: string;
      credentials: TokenMintCredentialValue["credentials"];
      token_path: string;
      refresh_token_path?: string;
      expires_in_path?: string;
      expires_at_path?: string;
      header_template?: string;
    }
  | ({ mode: "oauth2_client" } & OAuth2ClientCredentialValue)
  | ({ mode: "oauth2_private_key" } & OAuth2PrivateKeyCredentialValue);

function serializePlain(value: CredentialPlaintext): string {
  switch (value.mode) {
    case "none":
      return "";
    case "header":
      return JSON.stringify({ headers: value.headers });
    case "query":
      return JSON.stringify({ query: value.query });
    case "bearer":
      return JSON.stringify({ token: value.token });
    case "basic":
      return JSON.stringify({ username: value.username, password: value.password });
    case "oauth2":
      return JSON.stringify({
        access_token: value.access_token,
        token_type: value.token_type ?? "Bearer",
        scope: value.scope,
      });
    case "aws_sigv4":
      return JSON.stringify({
        access_key_id: value.access_key_id,
        secret_access_key: value.secret_access_key,
        ...(value.session_token ? { session_token: value.session_token } : {}),
      });
    case "token_mint":
      return JSON.stringify({
        access_token: value.access_token,
        shape: value.shape,
        mint_endpoint: value.mint_endpoint,
        credentials: value.credentials,
        token_path: value.token_path,
        ...(value.refresh_token_path ? { refresh_token_path: value.refresh_token_path } : {}),
        ...(value.expires_in_path ? { expires_in_path: value.expires_in_path } : {}),
        ...(value.expires_at_path ? { expires_at_path: value.expires_at_path } : {}),
        ...(value.header_template ? { header_template: value.header_template } : {}),
      });
    case "oauth2_client":
      return JSON.stringify({
        client_id: value.client_id,
        ...(value.client_secret ? { client_secret: value.client_secret } : {}),
      });
    case "oauth2_private_key":
      return JSON.stringify({
        client_id: value.client_id,
        private_key: value.private_key,
        algorithm: value.algorithm,
      });
  }
}

function deserializePlain(mode: CredentialMode, raw: string): DecryptedCredential {
  if (mode === "none") return { mode: "none" };
  const parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  switch (mode) {
    case "header":
      return { mode: "header", headers: (parsed.headers as Record<string, string>) ?? {} };
    case "query":
      return { mode: "query", query: (parsed.query as Record<string, string>) ?? {} };
    case "bearer":
      return { mode: "bearer", token: String(parsed.token ?? "") };
    case "basic":
      return {
        mode: "basic",
        username: String(parsed.username ?? ""),
        password: String(parsed.password ?? ""),
      };
    case "oauth2":
      return {
        mode: "oauth2",
        access_token: String(parsed.access_token ?? ""),
        token_type: String(parsed.token_type ?? "Bearer"),
        scope: parsed.scope as string | undefined,
        refresh_token: null,
        expires_at: null,
      };
    case "aws_sigv4":
      return {
        mode: "aws_sigv4",
        access_key_id: String(parsed.access_key_id ?? ""),
        secret_access_key: String(parsed.secret_access_key ?? ""),
        ...(typeof parsed.session_token === "string"
          ? { session_token: parsed.session_token }
          : {}),
      };
    case "token_mint":
      return {
        mode: "token_mint",
        access_token: String(parsed.access_token ?? ""),
        refresh_token: null,
        expires_at: null,
        shape: (parsed.shape as TokenMintShape) ?? "json",
        mint_endpoint: String(parsed.mint_endpoint ?? ""),
        credentials: (parsed.credentials as TokenMintCredentialValue["credentials"]) ?? {
          username: "",
          password: "",
        },
        token_path: String(parsed.token_path ?? ""),
        ...(typeof parsed.refresh_token_path === "string"
          ? { refresh_token_path: parsed.refresh_token_path }
          : {}),
        ...(typeof parsed.expires_in_path === "string"
          ? { expires_in_path: parsed.expires_in_path }
          : {}),
        ...(typeof parsed.expires_at_path === "string"
          ? { expires_at_path: parsed.expires_at_path }
          : {}),
        ...(typeof parsed.header_template === "string"
          ? { header_template: parsed.header_template }
          : {}),
      };
    case "oauth2_client":
      return {
        mode: "oauth2_client",
        client_id: String(parsed.client_id ?? ""),
        ...(typeof parsed.client_secret === "string"
          ? { client_secret: parsed.client_secret }
          : {}),
      };
    case "oauth2_private_key":
      return {
        mode: "oauth2_private_key",
        client_id: String(parsed.client_id ?? ""),
        private_key: String(parsed.private_key ?? ""),
        algorithm: String(parsed.algorithm ?? ""),
      };
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      throw new Error(`unknown credential mode: ${mode}`);
    }
  }
}

export interface UpsertCredentialInput {
  tenant_id: string;
  /** Owning connector — including an external MCP server, which is a
   *  connector whose driver is `mcp`. */
  connector_id: string;
  environment: "dev" | "prod";
  mode: CredentialMode;
  value: CredentialPlaintext;
  oauth2_refresh_token?: string | null;
  oauth2_expires_at?: Date | null;
  /**
   * G6 (runtime-logs review plan): scopes the IdP actually granted on
   * the most recent OAuth flow, as the raw space-separated string from
   * the token-exchange response. Persisted on the credential row so
   * probe / test can diff against the connector template's expected
   * scopes and surface a `partial_grant` warning to the LLM. Optional
   * because non-oauth2 credentials and pre-G6 callers leave it null.
   */
  oauth2_granted_scopes?: string | null;
  /**
   * Point the credential at an outbound connection (Cockpit "Verbindung
   * wählen"). The stored payload is then an empty `oauth2` value; the access
   * token is read from the connection's current secret version at use time.
   */
  connection_id?: string | null;
  actor_id: string | null;
  /** Provenance tag stamped into the audit metadata so operators can
   *  distinguish callback-triggered writes (`oauth_callback`) from
   *  conversation-tool writes (`conversation_tool`), refresh-worker
   *  rotations (`refresh_worker`), HTTP route writes (`http_route`),
   *  and CLI-driven setup. Optional for backwards-compat with internal
   *  callers; missing is recorded as `unspecified`. */
  source?: CredentialWriteSource;
}

export type CredentialWriteSource =
  | "oauth_callback"
  | "conversation_tool"
  | "refresh_worker"
  | "http_route"
  | "cli_bootstrap"
  | "connector_promotion"
  // Browser-submitted via the single-use credential-setup grant form
  // (GET/POST /v1/connectors/{id}/credentials/setup) — the non-OAuth
  // counterpart to `oauth_callback`.
  | "credential_setup_grant"
  | "unspecified";

function toBuf(u: Uint8Array): Buffer {
  return Buffer.from(u);
}

/**
 * Insert or replace a credential for a connector/environment pair.
 * AAD is `credential:{tenant}:{credential_id}` on the primary triple and
 * `credential-refresh:...` on the oauth2 refresh triple.
 */
export async function upsertCredential(
  input: UpsertCredentialInput,
  exec?: Executor,
): Promise<CredentialRow> {
  const db = exec ?? getDb();
  const ownerPredicate = eq(credentials.connector_id, input.connector_id);
  // Two-step encrypt: insert a row with placeholder bytes so we have the
  // id, then update with the real ciphertext keyed on the id. This keeps
  // the AAD = tenant_id + credential_id contract intact. Postgres lets
  // us do this in a single transaction trivially.
  return await db.transaction(async (tx) => {
    // Credentials are bucketed into two slots:
    //   - the "oauth2_client" slot: RFC 7591 registered OAuth2 client
    //     identity (client_id + client_secret). At most one row per
    //     (connector, environment).
    //   - the "primary" slot: user-facing auth material — bearer, oauth2
    //     access token, header, query, basic, aws_sigv4, token_mint.
    //     At most one row per (connector, environment); operators may
    //     switch modes (e.g. bearer → oauth2) which mutates the row in
    //     place so call-sites that hold the credential_id stay valid.
    // The two slots coexist so an OAuth callback writing `mode: "oauth2"`
    // never clobbers the dynamically-registered client identity that the
    // refresh-token grant still needs.
    const isClientSlot = input.mode === "oauth2_client";
    const slotPredicate = isClientSlot
      ? eq(credentials.mode, "oauth2_client")
      : ne(credentials.mode, "oauth2_client");
    // This function runs inside data migrations (and their proofs) against
    // the schema that preceded 0048, so it names only the columns every
    // release has had: the select projects legacy identity/material columns, the insert is written by
    // hand there, and `connection_id` is set only where it exists.
    const withConnectionColumn = await hasCredentialConnectionColumn(tx);
    const withAuthorityRevision = await hasCredentialAuthorityRevisionColumn(tx);
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
        ...(withConnectionColumn ? { connection_id: credentials.connection_id } : {}),
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

    // Allocate a placeholder row first to get the id for AAD binding.
    const placeholder = encryptSecret("__placeholder__");
    let id: string;
    if (priorId) {
      id = priorId;
    } else if (withConnectionColumn && withAuthorityRevision) {
      const [row] = await tx
        .insert(credentials)
        .values({
          tenant_id: input.tenant_id,
          connector_id: input.connector_id,
          environment: input.environment,
          mode: input.mode,
          ciphertext: toBuf(placeholder.ciphertext),
          iv: toBuf(placeholder.iv),
          auth_tag: toBuf(placeholder.auth_tag),
        })
        .returning({ id: credentials.id });
      if (!row) throw new Error("credential insert returned no row");
      id = row.id;
    } else {
      const inserted = await tx.execute(
        sql`insert into ${credentials} ("tenant_id", "connector_id", "environment", "mode", "ciphertext", "iv", "auth_tag") values (${input.tenant_id}, ${input.connector_id}, ${input.environment}, ${input.mode}, ${toBuf(placeholder.ciphertext)}, ${toBuf(placeholder.iv)}, ${toBuf(placeholder.auth_tag)}) returning "id"`,
      );
      const row = (inserted.rows as Array<{ id: string }>)[0];
      if (!row) throw new Error("credential insert returned no row");
      id = row.id;
    }
    const plain = serializePlain(input.value);
    const grantedScopes =
      input.oauth2_granted_scopes ??
      (input.value.mode === "oauth2" ? (input.value.scope ?? null) : null);
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
        // An operator must still be able to replace unreadable old material.
        // Unknown equivalence means a new boundary, never retained authority.
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
        ciphertext: toBuf(payload.ciphertext),
        iv: toBuf(payload.iv),
        auth_tag: toBuf(payload.auth_tag),
        oauth2_refresh_ciphertext: refreshPayload ? toBuf(refreshPayload.ciphertext) : null,
        oauth2_refresh_iv: refreshPayload ? toBuf(refreshPayload.iv) : null,
        oauth2_refresh_auth_tag: refreshPayload ? toBuf(refreshPayload.auth_tag) : null,
        oauth2_expires_at: input.oauth2_expires_at ?? null,
        // G6: stash the IdP-granted scope string on the credential row
        // so probe / test can compute partial_grant without re-fetching
        // the OAuth bundle. Null for non-oauth2 modes (refresh-worker
        // and conversation-tool callers pass through).
        granted_scopes: grantedScopes,
        ...(withAuthorityRevision && authorityChanged
          ? { authority_revision: sql`${credentials.authority_revision} + 1` }
          : {}),
        ...(withConnectionColumn ? { connection_id: input.connection_id ?? null } : {}),
        updated_at: new Date(),
      })
      .where(eq(credentials.id, id));

    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
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

    return {
      id,
      tenant_id: input.tenant_id,
      connector_id: input.connector_id,
      environment: input.environment,
      mode: input.mode,
    };
  });
}

export async function rotateOAuth2Tokens(
  input: {
    tenant_id: string;
    credential_id: string;
    access_token: string;
    token_type?: string | undefined;
    scope?: string | undefined;
    refresh_token?: string | null | undefined;
    expires_at?: Date | null | undefined;
    actor_id: string | null;
  },
  exec?: Executor,
): Promise<void> {
  const db = exec ?? getDb();
  await db.transaction(async (tx) => {
    const [prior] = await tx
      .select({
        mode: credentials.mode,
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
    const previousScope = prior.granted_scopes ?? priorValue.scope ?? null;
    const nextScope = input.scope ?? previousScope;
    const previousType = priorValue.token_type ?? "Bearer";
    const nextType = input.token_type ?? previousType;
    // OAuth token type names are case-insensitive. The OAuth client normalizes
    // Bearer to bearer during refresh; that is not a new permission grant.
    const authorityChanged =
      !sameAuthorityScopes(previousScope, nextScope) ||
      previousType.toLowerCase() !== nextType.toLowerCase();
    const withAuthorityRevision = await hasCredentialAuthorityRevisionColumn(tx);
    const payload = encryptSecret(
      JSON.stringify({
        access_token: input.access_token,
        token_type: nextType,
        ...(nextScope === null ? {} : { scope: nextScope }),
      }),
      aadFor(input.tenant_id, input.credential_id),
    );
    const refreshPayload = input.refresh_token
      ? encryptSecret(input.refresh_token, refreshAadFor(input.tenant_id, input.credential_id))
      : null;
    await tx
      .update(credentials)
      .set({
        ciphertext: toBuf(payload.ciphertext),
        iv: toBuf(payload.iv),
        auth_tag: toBuf(payload.auth_tag),
        ...(refreshPayload
          ? {
              oauth2_refresh_ciphertext: toBuf(refreshPayload.ciphertext),
              oauth2_refresh_iv: toBuf(refreshPayload.iv),
              oauth2_refresh_auth_tag: toBuf(refreshPayload.auth_tag),
            }
          : {}),
        granted_scopes: nextScope,
        ...(withAuthorityRevision && authorityChanged
          ? { authority_revision: sql`${credentials.authority_revision} + 1` }
          : {}),
        oauth2_expires_at: input.expires_at ?? null,
        updated_at: new Date(),
      })
      .where(
        and(eq(credentials.tenant_id, input.tenant_id), eq(credentials.id, input.credential_id)),
      );
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.CREDENTIAL_ROTATED,
        resource_type: "credential",
        resource_id: input.credential_id,
        result: "success",
        metadata: { reason: "oauth2_refresh", authority_changed: authorityChanged },
      },
      tx,
    );
  });

  logger.info({
    module: "credentials",
    action: "credential.rotated",
    msg: "oauth2 credential rotated",
    credential_id: input.credential_id,
    tenant_id: input.tenant_id,
    expires_at: input.expires_at?.toISOString() ?? null,
  });
}

export async function getCredentialForConnector(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  exec?: Executor,
): Promise<{
  row: typeof credentials.$inferSelect;
  value: DecryptedCredential;
  connection_authority?: ConnectionAuthorityIdentity | null;
} | null> {
  // Draft-authoring flows probe a connector before it's been inserted —
  // their synthetic id looks like `draft-<conversation_uuid>` which
  // would make the UUID-typed credentials.connector_id column throw a
  // hard SQL error. Short-circuit the lookup so the probe continues
  // without pretending credentials were found.
  if (!UUID_RE.test(connector_id)) return null;
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        eq(credentials.environment, environment),
        // The `oauth2_client` mode is a registration-time identity slot, not
        // user-facing auth material. Callers asking for "the credential" want
        // the primary mode (oauth2 access token, bearer, etc.); the RFC 7591
        // client identity is read via `getOAuth2ClientCredential` below.
        ne(credentials.mode, "oauth2_client"),
        // Match authority review: a retained tombstone is never auth material.
        isNull(credentials.deleted_at),
      ),
    )
    // Deterministic pick: if a mode change (e.g. bearer → oauth2)
    // transiently leaves two primary-slot rows, always resolve the newest
    // so the resolver is stable instead of relying on physical row order.
    .orderBy(desc(credentials.created_at), desc(credentials.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // A credential that points at an outbound connection carries no token of
  // its own: the connection's current version is the token, refreshed on
  // the way if it is about to expire. An empty access token means the grant
  // is gone, which the driver reports as a missing credential rather than
  // sending nothing.
  if (row.connection_id) {
    const grant = await readAccessToken(db as Db, tenant_id, row.connection_id);
    return {
      row,
      connection_authority: grant?.connection_authority ?? null,
      value: {
        mode: "oauth2",
        access_token: grant?.access_token ?? "",
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
  // Grants like client_credentials_json store no refresh token but DO persist
  // expires_at so the staleness check works correctly. Read it here for any
  // oauth2 credential that doesn't already have expires_at set (i.e. no
  // refresh_token branch above ran).
  if (value.mode === "oauth2" && value.expires_at === null && row.oauth2_expires_at) {
    value.expires_at = row.oauth2_expires_at;
  }
  return { row, value };
}

/**
 * How a connector authenticates, for a page that must never see the material:
 * the mode, the environment, and the outbound connection it points at.
 */
export async function describeCredentialForConnector(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  exec?: Executor,
): Promise<{
  mode: string;
  environment: "dev" | "prod";
  connection: { id: string; name: string } | null;
  updated_at: string;
} | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const db = exec ?? getDb();
  const rows = await db
    .select({
      mode: credentials.mode,
      environment: credentials.environment,
      updated_at: credentials.updated_at,
      connection_id: credentials.connection_id,
      connection_name: outboundConnections.name,
    })
    .from(credentials)
    .leftJoin(outboundConnections, eq(outboundConnections.id, credentials.connection_id))
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        eq(credentials.environment, environment),
        ne(credentials.mode, "oauth2_client"),
      ),
    )
    .orderBy(desc(credentials.created_at), desc(credentials.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    mode: row.connection_id ? "connection" : row.mode,
    environment: row.environment,
    connection:
      row.connection_id && row.connection_name
        ? { id: row.connection_id, name: row.connection_name }
        : null,
    updated_at: row.updated_at.toISOString(),
  };
}

/** Load the `oauth2_client` credential for a connector — i.e. the
 *  client_id + client_secret issued by an IdP via RFC 7591 dynamic
 *  registration. Returns null if the connector was registered with a
 *  pre-provisioned OAuth client (the common case). Kept separate from
 *  `getCredentialForConnector` because that function returns the
 *  primary auth material and callers must opt in to the registration
 *  slot. AAD-bound by `aadFor(tenant_id, credential_id)`. */
export async function getOAuth2ClientCredential(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  exec?: Executor,
): Promise<{ client_id: string; client_secret: string | undefined } | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const db = exec ?? getDb();
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
  return { client_id: value.client_id, client_secret: value.client_secret };
}

/**
 * Determine the environment a connector actually has an authorised primary
 * credential for, so dry-run flows can avoid hard-pinning "dev" when the
 * connector only has a prod grant.
 *
 * Resolution order (mirrors the preference stated in the connector-builder
 * spec):
 *   1. dev  — when a primary-slot dev credential exists.
 *   2. prod — when a primary-slot prod credential exists but no dev one.
 *   3. null — when neither environment has a credential (never-configured
 *              or draft connector id that is not yet a UUID).
 *
 * Read-only — no audit entry is written.
 */
export async function resolveDefaultEnvironmentForConnector(
  tenant_id: string,
  connector_id: string,
  exec?: Executor,
): Promise<"dev" | "prod" | null> {
  // Draft-authoring flows use synthetic ids like `draft-<uuid>`. The
  // credentials.connector_id column is UUID-typed; a non-UUID value
  // would throw a Postgres 22P02 (invalid_text_representation).
  if (!UUID_RE.test(connector_id)) return null;
  const db = exec ?? getDb();
  const rows = await db
    .select({ environment: credentials.environment })
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        // Only primary-slot rows — skip the oauth2_client registration
        // identity slot, which always exists alongside the real grant.
        ne(credentials.mode, "oauth2_client"),
        inArray(credentials.environment, ["dev", "prod"]),
      ),
    )
    // Fetch both environments in one query; we pick dev below if present.
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.some((r) => r.environment === "dev")) return "dev";
  return "prod";
}

/**
 * Resolve the effective execution environment for a dry-run. When the
 * caller passes `requested`, that value is authoritative. Otherwise probe
 * the credentials table for every connector referenced by the draft
 * steps: prefer "dev" when any connector has a dev grant, fall back to
 * "prod" when all connectors only have prod grants. When no referenced
 * connector has any credential (mis-configured, or no connector_id
 * steps), default to "dev" and warn so the operator understands why the
 * run may 404/401. Extracted from dry-run-workflow.ts so the credential
 * logic lives next to `resolveDefaultEnvironmentForConnector`.
 */
export async function resolveDryRunEnvironment(p: {
  tenant_id: string;
  steps: unknown[];
  requested?: "dev" | "prod" | undefined;
  exec?: Executor;
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
  // Keyless connectors (auth_type "none" — public APIs like open-meteo) need
  // no credential, so they must not count toward the "no credential found"
  // check. Without this, a workflow built only from keyless connectors warns
  // "the run may fail with 401/404" even though the run cannot fail on auth —
  // a false positive that mislabels a perfectly healthy dry-run.
  const db = p.exec ?? getDb();
  const uuidIds = connectorIds.filter((id) => UUID_RE.test(id));
  const authRows = uuidIds.length
    ? await db
        .select({ id: connectors.id, auth_type: connectors.auth_type })
        .from(connectors)
        .where(and(eq(connectors.tenant_id, p.tenant_id), inArray(connectors.id, uuidIds)))
    : [];
  const keyless = new Set(authRows.filter((r) => r.auth_type === "none").map((r) => r.id));
  const authRequiringIds = connectorIds.filter((id) => !keyless.has(id));
  // Every referenced connector is keyless → no credential is ever needed.
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

/** Load the `oauth2_private_key` credential for a connector — the
 *  client_id, PEM/JWK private key, and signing algorithm used to
 *  construct a `PrivateKeyJwtProvider` for machine-to-machine OAuth2
 *  (today: an `mcp` connector declaring `oauth2_private_key_jwt`).
 *  Returns null when the connector has no private-key credential stored.
 *  AAD-bound by `aadFor(tenant_id, credential_id)`. Tenant/connector-scoped
 *  via both predicates — never read across tenants. */
export async function getOAuth2PrivateKeyCredential(
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  exec?: Executor,
): Promise<{ client_id: string; private_key: string; algorithm: string } | null> {
  if (!UUID_RE.test(connector_id)) return null;
  const db = exec ?? getDb();
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
    // Deterministic pick — mirrors `getOAuth2ClientCredential`.
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
  return { client_id: value.client_id, private_key: value.private_key, algorithm: value.algorithm };
}

export async function deleteCredential(
  tenant_id: string,
  credential_id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? getDb();
  const result = await db
    .delete(credentials)
    .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.id, credential_id)));
  const ok = (result as { rowCount?: number }).rowCount
    ? (result as { rowCount?: number }).rowCount! > 0
    : true;
  if (ok) {
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
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
