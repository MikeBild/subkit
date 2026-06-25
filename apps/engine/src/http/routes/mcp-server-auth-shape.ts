// Write-only secret ↔ auth-kind shape validation for the MCP-servers routes.
//
// Extracted from `mcp-servers.ts` to keep the route file under the 1000-LOC
// ceiling and to give the per-kind secret-shape rules a single cohesive home.
// These are PURE validators — no DB, no I/O — so they stay trivially testable
// and the route file keeps only request/response wiring. The secret value is
// NEVER echoed in any thrown message.

import { UnprocessableEntityError } from "../errors.ts";

/** The write-only credential fields a create/patch may carry. */
export interface SecretFields {
  token?: string | undefined;
  username?: string | undefined;
  refresh_token?: string | undefined;
  client_secret?: string | undefined;
  private_key?: string | undefined;
}

/** `none`: no secret field of any kind may be present. */
function assertNoneSecretShape(s: SecretFields): void {
  if (
    s.token !== undefined ||
    s.refresh_token !== undefined ||
    s.username !== undefined ||
    s.client_secret !== undefined ||
    s.private_key !== undefined
  ) {
    throw new UnprocessableEntityError("auth_config.kind 'none' must not carry a secret");
  }
}

/** `bearer`: the secret is `token`; `refresh_token` / `username` are the
 *  wrong fields. When `requireSecret`, a `token` must be supplied. */
function assertBearerSecretShape(s: SecretFields, requireSecret: boolean): void {
  if (s.refresh_token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'bearer' uses the 'token' field, not 'refresh_token'",
    );
  }
  if (s.username !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'bearer' does not use 'username' — that field belongs to kind 'basic'",
    );
  }
  if (requireSecret && s.token === undefined) {
    throw new UnprocessableEntityError("auth_config.kind 'bearer' requires a 'token'");
  }
}

/** `basic`: the credential is the `username` + `token` pair, rotated
 *  atomically — one without the other is always a 422 (a half-rotated
 *  basic credential is unusable). When `requireSecret`, both must be
 *  supplied. */
function assertBasicSecretShape(s: SecretFields, requireSecret: boolean): void {
  if (s.refresh_token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'basic' uses 'username' + 'token', not 'refresh_token'",
    );
  }
  if ((s.username === undefined) !== (s.token === undefined)) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'basic' requires 'username' and 'token' together",
    );
  }
  if (requireSecret && s.token === undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'basic' requires a 'username' and a 'token'",
    );
  }
}

/** `oauth2`: the secret is `refresh_token`; `token` / `username` are the
 *  wrong fields. The refresh token is OPTIONAL even on create — absent
 *  means the interactive `POST /{id}/authorize` consent flow mints and
 *  persists the token pair (the server parks in error+backoff until then,
 *  the same degradation as any unauthorized handshake). */
function assertOAuth2SecretShape(s: SecretFields): void {
  if (s.token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2' uses the 'refresh_token' field, not 'token'",
    );
  }
  if (s.username !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2' does not use 'username' — that field belongs to kind 'basic'",
    );
  }
  if (s.client_secret !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2' does not use 'client_secret' — use kind 'oauth2_client_credentials'",
    );
  }
  if (s.private_key !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2' does not use 'private_key' — use kind 'oauth2_private_key_jwt'",
    );
  }
}

/** `oauth2_client_credentials`: requires `client_secret` on create.
 *  Does not use `token`, `username`, `refresh_token`, or `private_key`.
 *  `auth_config.client_id` must be supplied (enforced in the handler). */
function assertClientCredentialsSecretShape(s: SecretFields, requireSecret: boolean): void {
  if (s.token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_client_credentials' uses 'client_secret', not 'token'",
    );
  }
  if (s.username !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_client_credentials' does not use 'username'",
    );
  }
  if (s.refresh_token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_client_credentials' does not use 'refresh_token'",
    );
  }
  if (s.private_key !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_client_credentials' does not use 'private_key' — use kind 'oauth2_private_key_jwt'",
    );
  }
  if (requireSecret && s.client_secret === undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_client_credentials' requires a 'client_secret'",
    );
  }
}

/** `oauth2_private_key_jwt`: requires `private_key` on create.
 *  Does not use `token`, `username`, `refresh_token`, or `client_secret`.
 *  `auth_config.client_id` and `auth_config.algorithm` must be supplied
 *  (enforced in the handler). */
function assertPrivateKeyJwtSecretShape(s: SecretFields, requireSecret: boolean): void {
  if (s.token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_private_key_jwt' uses 'private_key', not 'token'",
    );
  }
  if (s.username !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_private_key_jwt' does not use 'username'",
    );
  }
  if (s.refresh_token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_private_key_jwt' does not use 'refresh_token'",
    );
  }
  if (s.client_secret !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_private_key_jwt' does not use 'client_secret' — use kind 'oauth2_client_credentials'",
    );
  }
  if (requireSecret && s.private_key === undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_private_key_jwt' requires a 'private_key'",
    );
  }
}

/** Reject a create/patch whose write-only secret does not match the
 *  declared `auth_config.kind`, dispatching to the named per-kind shape
 *  check so the error message is unambiguous about which field belongs to
 *  which kind. Never echoes the secret. `requireSecret` defaults to true
 *  (create path); the patch path passes false when no rotation was
 *  requested so an unchanged-secret kind is allowed. */
export function assertSecretMatchesKind(
  kind:
    | "none"
    | "bearer"
    | "basic"
    | "oauth2"
    | "oauth2_client_credentials"
    | "oauth2_private_key_jwt",
  secrets: SecretFields,
  opts?: { requireSecret?: boolean },
): void {
  const requireSecret = opts?.requireSecret ?? true;
  switch (kind) {
    case "none":
      assertNoneSecretShape(secrets);
      return;
    case "bearer":
      assertBearerSecretShape(secrets, requireSecret);
      return;
    case "basic":
      assertBasicSecretShape(secrets, requireSecret);
      return;
    case "oauth2":
      assertOAuth2SecretShape(secrets);
      return;
    case "oauth2_client_credentials":
      assertClientCredentialsSecretShape(secrets, requireSecret);
      return;
    case "oauth2_private_key_jwt":
      assertPrivateKeyJwtSecretShape(secrets, requireSecret);
      return;
    default: {
      const exhaustive: never = kind;
      void exhaustive;
    }
  }
}

/** Reject an M2M create/patch whose non-secret identity fields are missing
 *  from `auth_config`. The SDK providers need `client_id` (both kinds) and a
 *  signing `algorithm` (private_key_jwt) at handshake; without them
 *  `writeMcpServerCredential` would coerce `undefined` into an empty stored
 *  field that only fails later at connect. Enforced on BOTH create and patch
 *  so a credential is never persisted half-formed. No-op for non-M2M kinds. */
export function assertM2MAuthConfigComplete(
  kind: string,
  authConfig: { client_id?: string | undefined; algorithm?: string | undefined } | null | undefined,
): void {
  if (kind === "oauth2_client_credentials" && !authConfig?.client_id) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2_client_credentials' requires auth_config.client_id",
    );
  }
  if (kind === "oauth2_private_key_jwt") {
    if (!authConfig?.client_id) {
      throw new UnprocessableEntityError(
        "auth_config.kind 'oauth2_private_key_jwt' requires auth_config.client_id",
      );
    }
    if (!authConfig?.algorithm) {
      throw new UnprocessableEntityError(
        "auth_config.kind 'oauth2_private_key_jwt' requires auth_config.algorithm",
      );
    }
  }
}
