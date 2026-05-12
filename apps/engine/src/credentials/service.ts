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

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { EncryptedPayload } from "../crypto/aes-gcm.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import { type Db, getDb } from "../db/client.ts";
import { credentials } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import type {
  AwsSigV4CredentialValue,
  BasicCredentialValue,
  BearerCredentialValue,
  CredentialMode,
  DecryptedCredential,
  HeaderCredentialValue,
  OAuth2CredentialValue,
  QueryCredentialValue,
  TokenMintCredentialValue,
  TokenMintShape,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    };

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
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      throw new Error(`unknown credential mode: ${mode}`);
    }
  }
}

export interface UpsertCredentialInput {
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  mode: CredentialMode;
  value: CredentialPlaintext;
  oauth2_refresh_token?: string | null;
  oauth2_expires_at?: Date | null;
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
  // Two-step encrypt: insert a row with placeholder bytes so we have the
  // id, then update with the real ciphertext keyed on the id. This keeps
  // the AAD = tenant_id + credential_id contract intact. Postgres lets
  // us do this in a single transaction trivially.
  return await db.transaction(async (tx) => {
    // Delete any existing credential for the same connector+env.
    const existing = await tx
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, input.tenant_id),
          eq(credentials.connector_id, input.connector_id),
          eq(credentials.environment, input.environment),
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
              connector_id: input.connector_id,
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
  return { row, value };
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
