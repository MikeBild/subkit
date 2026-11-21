import { z } from "@hono/zod-openapi";
import {
  OAUTH_AUTHORIZATION_URL_FIELD,
  OAuthApprovalInputSchema,
} from "@shared/elicitation-constants.ts";
import type { OAuthFlowOrigin } from "../../connectors/oauth-origin.ts";
import {
  hasPendingConnectorOAuthState,
  insertConnectorOAuthState,
} from "../../connectors/oauth-states.ts";
import { getConnector } from "../../connectors/service.ts";
import { connectorSignIn } from "../../connectors/sign-in.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import { startAuthorizationCode } from "../../credentials/oauth2/client.ts";
import { buildOAuthRedirectUri } from "../../credentials/oauth2/redirect-uri.ts";
import {
  OAUTH_WAIT_CEILING_MS,
  OAUTH_WAIT_MIN_FLOOR_MS,
  type OAuthWaitStatus,
  waitForOAuthCredential,
} from "../../credentials/oauth2/wait.ts";
import { logger } from "../../logging/index.ts";
import { withConnectorAuthenticated } from "../authoring-state/index.ts";
import { decidedByFor } from "../decided-by.ts";
import { ElicitationUnsupportedError } from "../elicitation-bridge.ts";
import {
  createNativeElicitation,
  demoteElicitationToPortal,
  resolveElicitationAndReactivate,
} from "../elicitations.ts";
import { pauseForUserInput } from "./ask-user/common.ts";
import { resolveAndError } from "./elicitation-resolve.ts";
import {
  OAUTH_AUTHORIZATION_DECLINED,
  OAUTH_AUTHORIZATION_FAILED,
  OAUTH_ELICITATION_TRANSPORT_FAILED,
  OAUTH_TIMEOUT,
  WRONG_REAUTH_FLOW,
} from "./error-codes.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    connector_id: z
      .string()
      .uuid()
      .describe(
        "Saved connector to authorize. Falls back to the conversation's target_connector_id when omitted.",
      )
      .optional(),
    scopes: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "OAuth scopes to request. When omitted, the connector template's default scopes apply.",
      ),
    return_url: z
      .string()
      .url()
      .optional()
      .describe("Optional URL to redirect the user back to after a successful authorization."),
  })
  .openapi("AuthenticateOAuthToolInput");

function openOAuthApprovalElicitation(
  ctx: ToolContext,
  p: {
    connectorLabel: string;
    authorizationUrl: string;
    redirectUri: string;
    message: string;
    connectorId: string;
    connectorSlug: string;
  },
): Promise<import("../elicitations.ts").ElicitationRecord> {
  return createNativeElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: ctx.tool_call_id ?? null,
      ...(ctx.assistant_message_id ? { parent_message_id: ctx.assistant_message_id } : {}),
      tool_name: "ask_user_confirm",
      summary: `Authorize OAuth access for ${p.connectorLabel}.`,
      input: oauthApprovalInput(
        p.authorizationUrl,
        p.redirectUri,
        p.message,
        p.connectorId,
        p.connectorSlug,
      ),
      actor_id: ctx.actor_id,
    },
    ctx.db,
  );
}

async function resolveOAuthApprovalElicitation(
  ctx: ToolContext,
  elicitationId: string,
  status: OAuthWaitStatus,
): Promise<void> {
  await resolveElicitationAndReactivate(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      id: elicitationId,
      output: { status },
      decided_by: decidedByFor(ctx.actor_id, ctx.tenant_id, ctx.principal),
      status: status === "succeeded" ? "resolved" : "cancelled",
      ...(status === "succeeded" ? {} : { reason: mapOAuthWaitFailure(status).code }),
      transport: "succeeded",
    },
    ctx.db,
  );
}

function mapOAuthWaitFailure(status: "failed" | "timeout"): { code: string; message: string } {
  switch (status) {
    case "timeout":
      return {
        code: OAUTH_TIMEOUT,
        message:
          "Still waiting for the OAuth authorization to complete — the authorization is pending, not failed. The authorization URL and state row are still valid: call authenticate_oauth again for this connector to resume waiting for the same flow (it will NOT mint a new URL while the state row is live).",
      };
    case "failed":
      return {
        code: OAUTH_AUTHORIZATION_FAILED,
        message:
          "The OAuth authorization did not complete — no credential was persisted. Re-run authenticate_oauth to try again.",
      };
  }
}

async function hasPendingOAuthState(
  ctx: { db: import("../../db/client.ts").Db; tenant_id: string },
  connectorId: string,
): Promise<boolean> {
  return hasPendingConnectorOAuthState(ctx.db, ctx.tenant_id, connectorId, new Date());
}

function remainingWaitBudgetMs(bridgeStartedAt: number): number {
  const elapsed = performance.now() - bridgeStartedAt;
  return Math.max(OAUTH_WAIT_MIN_FLOOR_MS, OAUTH_WAIT_CEILING_MS - elapsed);
}

async function awaitOAuthCredentialAndFinalize(
  ctx: ToolContext,
  p: {
    connector: { display_name?: string | null; slug: string };
    connectorId: string;
    environment: "dev" | "prod";
    elicitationId: string;
    bridgeStartedAt: number;
    authorizationUrl: string;
    redirectUri: string;
    returnUrl?: string;
  },
): Promise<ToolResult> {
  const status = await waitForOAuthCredential({
    tenant_id: ctx.tenant_id,
    connector_id: p.connectorId,
    environment: p.environment,
    timeout_ms: remainingWaitBudgetMs(p.bridgeStartedAt),
    db: ctx.db,
  });
  await resolveOAuthApprovalElicitation(ctx, p.elicitationId, status);
  return finalizeWaitResult(ctx, p.connector, status, {
    authorization_url: p.authorizationUrl,
    redirect_uri: p.redirectUri,
    ...(p.returnUrl ? { return_url: p.returnUrl } : {}),
  });
}

export const authenticateOAuthTool: ConversationTool = {
  name: "authenticate_oauth",
  description:
    "Start the OAuth2 authorization-code dance for a saved connector. On MCP clients the authorization prompt is surfaced directly via elicitation and the tool blocks until tokens land; on the portal it pauses for confirmation. Never re-prompt the user for an access token in chat — that path is forbidden. Pair this with `save_connector_draft({ credential: { mode: 'oauth2', ... } })` for connectors with custom client_id/secret.",
  use_case:
    "After `save_connector_draft` for a connector whose template advertises `auth_type: oauth2` (or whose credential mode is `oauth2`), call this tool to obtain the authorization URL and complete authentication.",
  important_notes: [
    "Requires the connector to be saved (has an id in the connectors table). Use `save_connector_draft` first.",
    "The agent NEVER sees access tokens or refresh tokens — they are persisted server-side via the OAuth callback route.",
    "Returns `redirect_uri` alongside `authorization_url` — surface both to the operator. The redirect_uri must be added to the OAuth provider's allowlist BEFORE opening the authorization URL.",
  ],
  inputSchema,
  category: "tenant_write",
  authoring_resource: "connector",
  requires_skill: "oauth-flow",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connectorId = args.connector_id ?? ctx.connector_id ?? null;
    if (!connectorId) {
      return {
        ok: false,
        data: {
          error: "no_saved_connector",
          message:
            "authenticate_oauth requires a saved connector id. Save the draft first with save_connector_draft.",
        },
      };
    }
    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (!connector) {
      return {
        ok: false,
        data: {
          error: "connector_missing",
          message: `connector ${connectorId} was not found in this tenant.`,
        },
      };
    }
    const environment: "dev" | "prod" = connector.environment === "prod" ? "prod" : "dev";

    if (await hasPendingOAuthState(ctx, connectorId)) {
      const status = await waitForOAuthCredential({
        tenant_id: ctx.tenant_id,
        connector_id: connectorId,
        environment,
        db: ctx.db,
      });
      return finalizeWaitResult(ctx, connector, status);
    }

    const signIn = connectorSignIn(connector);
    if (signIn?.kind === "mcp") {
      return {
        ok: false,
        data: {
          error_code: WRONG_REAUTH_FLOW,
          message:
            "connector is an MCP server — it signs in on its own route (mcp/authorize), not the OAuth2 flow authenticate_oauth runs. Call request_connector_reauth for a one-time sign-in link instead.",
          next_best_actions: ["request_connector_reauth"],
        },
      };
    }

    const cfg = await resolveConnectorOAuthConfig(ctx.db, ctx.tenant_id, connector);
    if (!cfg) {
      return {
        ok: false,
        data: {
          error: "oauth_not_configured",
          message:
            "this connector is not configured for OAuth2 authentication. Either pick a template with OAuth or save the draft with credential.mode='oauth2'.",
        },
      };
    }
    if (connector.auth_type === "oauth2" && !signIn) {
      return {
        ok: false,
        data: {
          error_code: WRONG_REAUTH_FLOW,
          message:
            "connector uses Cognito USER_PASSWORD_AUTH (cognito_user_password), not a browser authorization-code flow — call request_connector_reauth to re-issue its credential (email + password) in chat instead of authenticate_oauth.",
          next_best_actions: ["request_connector_reauth"],
        },
      };
    }
    if (cfg.grant_type === "client_credentials_json") {
      return {
        ok: false,
        data: {
          error_code: WRONG_REAUTH_FLOW,
          message:
            "connector uses a client-credentials (M2M) grant (client_credentials_json), not a browser authorization-code flow — call request_connector_reauth to re-run the credential exchange instead of authenticate_oauth.",
          next_best_actions: ["request_connector_reauth"],
        },
      };
    }
    const redirect_uri = buildOAuthRedirectUri();
    if (!redirect_uri) {
      return {
        ok: false,
        data: {
          error: "engine_public_url_missing",
          message:
            "engine has no resolvable public origin — set server.public_base_url before running an OAuth2 flow.",
        },
      };
    }
    const cfgWithRedirect = { ...cfg, redirect_uri };
    const cfgWithScope =
      args.scopes && args.scopes.length > 0
        ? { ...cfgWithRedirect, scope: args.scopes.join(" ") }
        : cfgWithRedirect;
    const started = await startAuthorizationCode(cfgWithScope, {
      tenant_id: ctx.tenant_id,
      exec: ctx.db,
    });
    const expires = new Date(Date.now() + 10 * 60_000);
    await insertConnectorOAuthState(ctx.db, {
      tenant_id: ctx.tenant_id,
      connector_id: connectorId,
      state: started.state,
      code_verifier: started.code_verifier,
      redirect_uri,
      expires_at: expires,
      requested_scopes: cfgWithScope.scope ?? null,
      origin: "chat" satisfies OAuthFlowOrigin,
    });

    const connectorLabel = connector.display_name ?? connector.slug;
    const message =
      `Authorize ${connectorLabel} in your browser:\n${started.authorization_url}\n\n` +
      `Add this redirect URI to the OAuth provider's allowlist first:\n${redirect_uri}`;

    const bridge = ctx.elicitationBridge;

    if (bridge?.capabilities.oob) {
      const approval = await openOAuthApprovalElicitation(ctx, {
        connectorLabel,
        authorizationUrl: started.authorization_url,
        redirectUri: redirect_uri,
        message,
        connectorId,
        connectorSlug: connector.slug,
      });
      const bridgeStartedAt = performance.now();
      try {
        await bridge.elicitOob({
          url: started.authorization_url,
          message,
          elicitationId: started.state,
        });
      } catch (err) {
        if (err instanceof ElicitationUnsupportedError) {
          logger.warn({
            module: "conversation",
            action: "authenticate_oauth.oob_unsupported_fallback",
            msg: "MCP oob elicitation unsupported — degrading native row to DB-pause",
            tenant_id: ctx.tenant_id,
            connector_id: connectorId,
            elicitation_id: approval.id,
            error: err.message,
          });
          return demoteOAuthApprovalToPortal(
            ctx,
            approval.id,
            started.authorization_url,
            redirect_uri,
            message,
            connectorId,
            connector.slug,
          );
        }
        logger.warn({
          module: "conversation",
          action: "authenticate_oauth.oob_transport_failed",
          msg: "MCP oob elicitation transport failed",
          tenant_id: ctx.tenant_id,
          connector_id: connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
        return resolveAndError(ctx, approval.id, {
          reason: OAUTH_ELICITATION_TRANSPORT_FAILED,
          errorCode: OAUTH_ELICITATION_TRANSPORT_FAILED,
          message:
            "The MCP elicitation for the OAuth authorization URL failed in transit. The authorization state is still valid — call authenticate_oauth again for this connector to retry.",
          transport: "failed",
          data: { authorization_url: started.authorization_url, redirect_uri },
        });
      }
      return awaitOAuthCredentialAndFinalize(ctx, {
        connector,
        connectorId,
        environment,
        elicitationId: approval.id,
        bridgeStartedAt,
        authorizationUrl: started.authorization_url,
        redirectUri: redirect_uri,
        ...(args.return_url ? { returnUrl: args.return_url } : {}),
      });
    }

    if (bridge?.capabilities.form) {
      const approval = await openOAuthApprovalElicitation(ctx, {
        connectorLabel,
        authorizationUrl: started.authorization_url,
        redirectUri: redirect_uri,
        message,
        connectorId,
        connectorSlug: connector.slug,
      });
      const bridgeStartedAt = performance.now();
      try {
        const result = await bridge.elicitForm({
          message,
          requestedSchema: {
            type: "object",
            properties: {
              acknowledged: {
                type: "boolean",
                title: "I have opened the authorization URL",
                description: "Open the URL above, complete the OAuth flow, then confirm.",
              },
            },
            required: ["acknowledged"],
          },
        });
        if (result.action !== "accept" || result.content?.acknowledged !== true) {
          return resolveAndError(ctx, approval.id, {
            reason: OAUTH_AUTHORIZATION_DECLINED,
            errorCode: OAUTH_AUTHORIZATION_DECLINED,
            message: "The user declined to start the OAuth authorization.",
            transport: "succeeded",
            data: { authorization_url: started.authorization_url, redirect_uri },
          });
        }
      } catch (err) {
        if (err instanceof ElicitationUnsupportedError) {
          logger.warn({
            module: "conversation",
            action: "authenticate_oauth.form_unsupported_fallback",
            msg: "MCP form elicitation unsupported — degrading native row to DB-pause",
            tenant_id: ctx.tenant_id,
            connector_id: connectorId,
            elicitation_id: approval.id,
            error: err.message,
          });
          return demoteOAuthApprovalToPortal(
            ctx,
            approval.id,
            started.authorization_url,
            redirect_uri,
            message,
            connectorId,
            connector.slug,
          );
        }
        logger.warn({
          module: "conversation",
          action: "authenticate_oauth.form_transport_failed",
          msg: "MCP form elicitation transport failed",
          tenant_id: ctx.tenant_id,
          connector_id: connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
        return resolveAndError(ctx, approval.id, {
          reason: OAUTH_ELICITATION_TRANSPORT_FAILED,
          errorCode: OAUTH_ELICITATION_TRANSPORT_FAILED,
          message:
            "The MCP elicitation for the OAuth authorization URL failed in transit. The authorization state is still valid — call authenticate_oauth again for this connector to retry.",
          transport: "failed",
          data: { authorization_url: started.authorization_url, redirect_uri },
        });
      }
      return awaitOAuthCredentialAndFinalize(ctx, {
        connector,
        connectorId,
        environment,
        elicitationId: approval.id,
        bridgeStartedAt,
        authorizationUrl: started.authorization_url,
        redirectUri: redirect_uri,
        ...(args.return_url ? { returnUrl: args.return_url } : {}),
      });
    }

    return dbPauseForOAuth(
      ctx,
      started.authorization_url,
      redirect_uri,
      message,
      connectorId,
      connector.slug,
    );
  },
};

function oauthApprovalInput(
  authorizationUrl: string,
  redirectUri: string,
  message: string,
  connectorId: string,
  connectorSlug: string,
): Record<string, unknown> {
  const parsed = OAuthApprovalInputSchema.parse({
    kind: "external_write",
    question: "Have you completed the authorization in your browser?",
    summary: message,
    [OAUTH_AUTHORIZATION_URL_FIELD]: authorizationUrl,
    redirect_uri: redirectUri,
  });
  return {
    ...parsed,
    commit_intent: {
      kind: "oauth_completed",
      payload: { connector_id: connectorId, connector_slug: connectorSlug },
      description: `Resume work that was blocked on ${connectorSlug}: the credential is now active.`,
    },
  };
}

function dbPauseForOAuth(
  ctx: import("./index.ts").ToolContext,
  authorizationUrl: string,
  redirectUri: string,
  message: string,
  connectorId: string,
  connectorSlug: string,
): Promise<ToolResult> {
  return pauseForUserInput(
    ctx,
    {
      tool_name: "ask_user_confirm",
      summary: message,
      input: oauthApprovalInput(authorizationUrl, redirectUri, message, connectorId, connectorSlug),
    },
    { authorizationUrl },
  );
}

async function demoteOAuthApprovalToPortal(
  ctx: ToolContext,
  rowId: string,
  authorizationUrl: string,
  redirectUri: string,
  message: string,
  connectorId: string,
  connectorSlug: string,
): Promise<ToolResult> {
  await demoteElicitationToPortal(ctx.tenant_id, rowId, ctx.db);
  return {
    ok: true,
    data: { status: "awaiting_input", elicitation_id: rowId },
    pause: {
      tool_name: "ask_user_confirm",
      summary: message,
      elicitation_id: rowId,
      input: oauthApprovalInput(authorizationUrl, redirectUri, message, connectorId, connectorSlug),
    },
  };
}

async function finalizeWaitResult(
  ctx: import("./index.ts").ToolContext,
  connector: { display_name?: string | null; slug: string },
  status: OAuthWaitStatus,
  extra?: Record<string, unknown>,
): Promise<ToolResult> {
  if (status === "succeeded") {
    const draft = ctx.getDraft();
    if (draft.connector) {
      const next = withConnectorAuthenticated(
        draft,
        draft.connector,
        true,
        `OAuth tokens persisted for ${connector.display_name ?? connector.slug}.`,
        "authenticate_oauth",
      );
      await ctx.setDraft(next);
    }
    return {
      ok: true,
      data: {
        status: "authenticated",
        connector: connector.slug,
        ...(extra ?? {}),
      },
    };
  }
  const failure = mapOAuthWaitFailure(status);
  return {
    ok: false,
    error_code: failure.code,
    message: failure.message,
    data: { status, ...(extra ?? {}) },
  };
}
