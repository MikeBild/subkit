import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { mcpOauthAccessTokens, mcpOauthClients, users } from "../../db/schema/index.ts";
import {
  assertTenantActive,
  issueCliOAuthSessionApiKey,
  SelfServiceIdentityError,
} from "../../identity/index.ts";
import { withContext } from "../../logging/context.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { revokeOAuthRefreshTokenFamily } from "./refresh-token-revocation.ts";
import { CLI_LOGIN_SCOPE, oauthResource } from "./resources.ts";
import { constantTimeHexEquals, parseMcpToken } from "./tokens.ts";

type CliSessionTokenError = "invalid_token" | "insufficient_scope";

type ConsumeCliLoginTokenResult =
  | {
      ok: true;
      api_key: string;
      principal_id: string;
      context_id: string;
      email: string;
    }
  | { ok: false; error: CliSessionTokenError };

export async function consumeCliLoginToken(input: {
  db: Db;
  token: string;
  publicBaseUrl: string;
  requestSource: RequestSource;
  userAgent?: string | undefined;
}): Promise<ConsumeCliLoginTokenResult> {
  const parsed = parseMcpToken(input.token);
  if (parsed?.kind !== "access") return { ok: false, error: "invalid_token" };

  // tenant-filter:exempt — prefix-based OAuth credential lookup happens before
  // the signed token row establishes the tenant boundary.
  const tokenRows = await input.db
    .select()
    .from(mcpOauthAccessTokens)
    .where(eq(mcpOauthAccessTokens.prefix, parsed.prefix))
    .limit(1);
  const tokenRow = tokenRows[0];
  if (!tokenRow || !constantTimeHexEquals(tokenRow.token_sha256, parsed.hash)) {
    return { ok: false, error: "invalid_token" };
  }

  const expected = oauthResource(
    input.publicBaseUrl,
    `${input.publicBaseUrl}/v1/identity/cli-session`,
  );
  if (!expected || tokenRow.resource !== expected.resource) {
    return { ok: false, error: "invalid_token" };
  }
  const scopes = tokenRow.scope.split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== CLI_LOGIN_SCOPE) {
    return { ok: false, error: "insufficient_scope" };
  }
  const checkedAt = new Date();
  if (tokenRow.revoked_at || tokenRow.expires_at <= checkedAt) {
    return { ok: false, error: "invalid_token" };
  }

  try {
    return await withContext(
      {
        tenant_id: tokenRow.tenant_id,
        actor_id: tokenRow.user_id,
        request_source: input.requestSource,
        audit_origin_source: "cli",
        audit_execution_source: input.requestSource,
        audit_access_type: "token_exchange",
        audit_oauth_client_id: tokenRow.client_id,
        audit_credential_origin: "cli_oauth_session",
      },
      () =>
        input.db.transaction(async (tx) => {
          await assertTenantActive(tokenRow.tenant_id, tx);
          const userRows = await tx
            .select({
              id: users.id,
              email: users.email,
              status: users.status,
              deleted_at: users.deleted_at,
            })
            .from(users)
            .where(and(eq(users.id, tokenRow.user_id), eq(users.tenant_id, tokenRow.tenant_id)))
            .for("update");

          // tenant-filter:exempt — OAuth clients are platform-global.
          await tx
            .select({ client_id: mcpOauthClients.client_id })
            .from(mcpOauthClients)
            .where(eq(mcpOauthClients.client_id, tokenRow.client_id))
            .for("update");

          if (tokenRow.refresh_token_id) {
            await revokeOAuthRefreshTokenFamily(
              tx,
              tokenRow.refresh_token_id,
              tokenRow.tenant_id,
              checkedAt,
              tokenRow.id,
            );
          }

          const claimed = await tx
            .update(mcpOauthAccessTokens)
            .set({ revoked_at: checkedAt, last_used_at: checkedAt })
            .where(
              and(
                eq(mcpOauthAccessTokens.id, tokenRow.id),
                eq(mcpOauthAccessTokens.tenant_id, tokenRow.tenant_id),
                isNull(mcpOauthAccessTokens.revoked_at),
              ),
            )
            .returning({ id: mcpOauthAccessTokens.id });
          if (claimed.length !== 1) throw new Error("cli_oauth_token_already_consumed");

          const user = userRows[0];
          if (user?.status !== "active" || user.deleted_at) {
            return { ok: false as const, error: "invalid_token" as const };
          }

          const issued = await issueCliOAuthSessionApiKey(
            {
              issuer: { kind: "login" },
              tenant_id: tokenRow.tenant_id,
              owner_kind: "user",
              owner_id: user.id,
              name: "SubKit CLI",
              scopes: ["*"],
              actor: { kind: "user", id: user.id },
            },
            tx,
          );
          await auditAwait(
            {
              tenant_id: tokenRow.tenant_id,
              actor_type: "user",
              actor_id: user.id,
              action: AuditAction.SK_CLI_LOGIN,
              resource_type: "user",
              resource_id: user.id,
              result: "success",
              metadata: {
                request_source: input.requestSource,
                oauth_client_id: tokenRow.client_id,
                oauth_access_token_id: tokenRow.id,
                user_agent: input.userAgent ?? null,
              },
            },
            tx,
          );

          return {
            ok: true as const,
            api_key: issued.plaintext,
            principal_id: user.id,
            context_id: tokenRow.tenant_id,
            email: user.email,
          };
        }),
    );
  } catch (error) {
    if (error instanceof SelfServiceIdentityError) return { ok: false, error: "invalid_token" };
    if (error instanceof Error && error.message === "cli_oauth_token_already_consumed") {
      return { ok: false, error: "invalid_token" };
    }
    throw error;
  }
}
