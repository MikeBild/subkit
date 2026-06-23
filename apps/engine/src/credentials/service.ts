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

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { EncryptedPayload } from "../crypto/aes-gcm.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import { type Executor, getDb } from "../db/client.ts";
import { connectors, credentials } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

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
  QueryCredentialValue,
  TokenMintCredentialValue,
  TokenMintShape,
} from "./types.ts";

export interface CredentialRow {
  id: string;
  tenant_id: string;
  // Owning resource — EXACTLY ONE of these is non-null (DB-enforced by the
  // `credentials_owner_xor_check`). Connector credentials set
  // `connector_id`; external-MCP-server credentials set `mcp_server_id`.
  connector_id: string | null;
  mcp_server_id: string | null;
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
  | ({ mode: "oauth2_client" } & OAuth2ClientCredentialValue);

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
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      throw new Error(`unknown credential mode: ${mode}`);
    }
  }
}

export interface UpsertCredentialInput {
  tenant_id: string;
  /**
   * Owning resource — pass EXACTLY ONE of `connector_id` or
   * `mcp_server_id`. Connector credentials set `connector_id`;
   * external-MCP-server credentials set `mcp_server_id`. The XOR is
   * asserted here and DB-enforced by `credentials_owner_xor_check`.
   */
  connector_id?: string;
  mcp_server_id?: string;
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
  // Owner XOR — exactly one of connector_id / mcp_server_id, mirroring the
  // `credentials_owner_xor_check` DB constraint. Asserted here so the
  // failure is a clear application error rather than a raw 23514.
  if ((input.connector_id == null) === (input.mcp_server_id == null)) {
    throw new Error(
      "upsertCredential requires exactly one of connector_id or mcp_server_id to be set",
    );
  }
  const ownerPredicate =
    input.connector_id != null
      ? eq(credentials.connector_id, input.connector_id)
      : eq(credentials.mcp_server_id, input.mcp_server_id!);
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
    const existing = await tx
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, input.tenant_id),
          ownerPredicate,
          eq(credentials.environment, input.environment),
          slotPredicate,
        ),
      )
      .limit(1);
    const priorId = existing[0]?.id ?? null;

    // Allocate a placeholder row first to get the id for AAD binding.
    const placeholder = encryptSecret("__placeholder__");
    const inserted = priorId
      ? existing[0]!
      : (
          await tx
            .insert(credentials)
            .values({
              tenant_id: input.tenant_id,
              connector_id: input.connector_id ?? null,
              mcp_server_id: input.mcp_server_id ?? null,
              environment: input.environment,
              mode: input.mode,
              ciphertext: toBuf(placeholder.ciphertext),
              iv: toBuf(placeholder.iv),
              auth_tag: toBuf(placeholder.auth_tag),
            })
            .returning()
        )[0]!;

    const id = inserted.id;
    const plain = serializePlain(input.value);
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
        granted_scopes: input.oauth2_granted_scopes ?? null,
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
          connector_id: input.connector_id ?? null,
          mcp_server_id: input.mcp_server_id ?? null,
          environment: input.environment,
          mode: input.mode,
          source: input.source ?? "unspecified",
        },
      },
      tx,
    );

    return {
      id,
      tenant_id: input.tenant_id,
      connector_id: input.connector_id ?? null,
      mcp_server_id: input.mcp_server_id ?? null,
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
  const payload = encryptSecret(
    JSON.stringify({
      access_token: input.access_token,
      token_type: input.token_type ?? "Bearer",
      scope: input.scope,
    }),
    aadFor(input.tenant_id, input.credential_id),
  );
  let refreshPayload: EncryptedPayload | null = null;
  if (input.refresh_token) {
    refreshPayload = encryptSecret(
      input.refresh_token,
      refreshAadFor(input.tenant_id, input.credential_id),
    );
  }
  await db
    .update(credentials)
    .set({
      mode: "oauth2",
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
      metadata: { reason: "oauth2_refresh" },
    },
    db,
  );

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
      ),
    )
    // Deterministic pick: if a mode change (e.g. bearer → oauth2)
    // transiently leaves two primary-slot rows, always resolve the newest
    // so the resolver is stable instead of relying on physical row order.
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
 * Resolve the primary auth material for an external MCP server.
 * Mirrors `getCredentialForConnector`: same AAD derivation
 * (`credential:{tenant}:{credential_id}`, keyed on the row id, so it is
 * independent of which resource owns the row), same decrypt path, same
 * return shape. The `oauth2_client` registration slot is excluded — MCP
 * servers that perform dynamic client registration would read that via a
 * dedicated accessor, exactly as connectors do.
 */
export async function getCredentialForMcpServer(
  tenant_id: string,
  mcp_server_id: string,
  environment: "dev" | "prod",
  exec?: Executor,
): Promise<{
  row: typeof credentials.$inferSelect;
  value: DecryptedCredential;
} | null> {
  if (!UUID_RE.test(mcp_server_id)) return null;
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.mcp_server_id, mcp_server_id),
        eq(credentials.environment, environment),
        ne(credentials.mode, "oauth2_client"),
      ),
    )
    // Deterministic pick: with the partial unique index a server can
    // transiently hold both a bearer and an oauth2 primary-slot row right
    // after a kind change. Always resolve the newest so the handshake
    // credential is stable rather than depending on physical row order.
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
  // expires_at so the staleness check works correctly.
  if (value.mode === "oauth2" && value.expires_at === null && row.oauth2_expires_at) {
    value.expires_at = row.oauth2_expires_at;
  }
  return { row, value };
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

/** Load the `oauth2_client` credential for an external MCP server
 *  — i.e. the client_id (+ optional client_secret) issued by
 *  the server's IdP, either pre-provisioned or via RFC 7591 dynamic
 *  client registration. Mirrors `getOAuth2ClientCredential` (the
 *  connector variant) but scopes the row by `mcp_server_id`. Returns null
 *  when the server has no registration slot yet. AAD-bound by
 *  `aadFor(tenant_id, credential_id)`; the `client_secret` lives only in
 *  the encrypted `credentials` row, never on the `mcp_oauth_states` flow
 *  row or in `mcp_servers.auth_config` (secret-by-reference). */
export async function getOAuth2ClientCredentialForMcpServer(
  tenant_id: string,
  mcp_server_id: string,
  environment: "dev" | "prod",
  exec?: Executor,
): Promise<{ client_id: string; client_secret: string | undefined } | null> {
  if (!UUID_RE.test(mcp_server_id)) return null;
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.mcp_server_id, mcp_server_id),
        eq(credentials.environment, environment),
        eq(credentials.mode, "oauth2_client"),
      ),
    )
    // Deterministic pick — mirrors `getCredentialForMcpServer`. The
    // partial unique index makes a duplicate transient at most, but the
    // ORDER BY keeps the resolved client stable regardless of row order.
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
