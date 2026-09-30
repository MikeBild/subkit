// Public, token-gated credential-setup flow for non-OAuth (bearer / basic /
// header / query) connectors — the browser-openable counterpart to
// GET /v1/connectors/{id}/oauth/start?grant=… for connectors that have no
// OAuth authorization-code dance to redirect into.
//
//   GET  /v1/connectors/{id}/credentials/setup?grant=sksg_…  — UNAUTHENTICATED
//        (grant-token auth). Validates the single-use grant WITHOUT consuming
//        it (a second, later POST still needs to redeem it) and renders a
//        minimal HTML form for the connector's auth_type. Invalid/expired
//        grant → 400 HTML error page.
//
//   POST /v1/connectors/{id}/credentials/setup                — UNAUTHENTICATED
//        (grant-token auth). Form-encoded body, registered via app.openapi.
//        The urlencoded body is documented as a plain OpenAPI schema object
//        (not zod) so no body validator runs — the handler's parseFormBody
//        plus per-auth_type field checks remain the sole boundary validation,
//        keeping every error path an HTML page for the browser. Atomically
//        consumes the grant, upserts the credential, clears needs_reauth, and
//        renders a thank-you HTML page. Invalid/expired/replayed grant →
//        400 HTML.
//
// This is a SEPARATE path from POST /v1/connectors/{id}/credentials (the
// existing API-key-gated route, untouched) — that route stays for
// programmatic callers; this one is the secure link `request_connector_reauth`
// hands to an MCP operator to open in a browser.
//
// Security: the plaintext grant token must NEVER appear in logs or audit
// metadata — it is only ever placed into the rendered form's hidden `grant`
// field so the browser can round-trip it on submit.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import {
  buildCallbackPageHtml,
  clearConnectorReauth,
  consumeSetupGrant,
  escapeHtml,
  validateSetupGrant,
} from "../../../connectors/index.ts";
import {
  claimDraftCredentialNativeUrlElicitation,
  clearDraftCredential,
  completeDraftCredentialNativeUrlElicitation,
  markConnectorNativeUrlElicitationsComplete,
  releaseDraftCredentialNativeUrlElicitation,
  setDraftCredential,
  validateDraftCredentialSetup,
} from "../../../conversations/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import { logger } from "../../../logging/index.ts";
import type { AppEnv } from "../../openapi.ts";
import { parseFormBody } from "../oauth/shared.ts";

// Single-use grant token query parameter. Min-20 guards against random short
// strings but no semantic validation — validateSetupGrant/consumeSetupGrant
// enforce the sha256 match and expiry check.
const CredentialSetupGrantQuery = z
  .object({ grant: z.string().min(20) })
  .openapi("CredentialSetupGrantQuery");

const credentialSetupFormRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/credentials/setup",
  tags: ["connectors"],
  summary: "Browser-openable credential-setup form (single-use grant token)",
  // Unauthenticated: the LLM hands this URL to the operator to open in a
  // browser. Authentication is by way of the single-use opaque `grant`
  // query parameter (sksg_… token), which the engine generated and stored
  // in connector_credential_setup_grants as a sha256 hash. This GET
  // VALIDATES ONLY — it must not consume the grant, since the operator
  // still needs to submit the rendered form.
  request: { params: IdParam, query: CredentialSetupGrantQuery },
  responses: {
    200: { description: "OK (HTML form)", content: { "text/html": { schema: z.string() } } },
    400: {
      description: "Grant invalid/expired (HTML error page)",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

// Form fields the POST handler reads, documented as a plain OpenAPI schema
// object rather than a zod schema. A zod form schema here would make
// @hono/zod-openapi register a body validator that (a) consumes the raw
// request body before the handler's parseFormBody can read it and (b) sends
// malformed submissions to the JSON defaultHook instead of the HTML error
// pages a browser expects. Every field is optional in the document because
// which fields are required depends on the connector's auth_type — the
// handler enforces them per mode.
const credentialSetupSubmitRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/credentials/setup",
  tags: ["connectors"],
  summary: "Submit the credential-setup form (consumes the single-use grant)",
  // Unauthenticated, same as the GET twin: authentication is the single-use
  // `grant` token round-tripped from the rendered form's hidden field. The
  // grant is consumed atomically on submit — a replay renders a 400 HTML page.
  request: {
    params: IdParam,
    body: {
      description:
        "HTML-form submission. `grant` is always required; exactly one of the " +
        "per-auth_type field sets applies: `token` (bearer), `username`+`password` " +
        "(basic), `header_name`+`header_value` (header), `query_name`+`query_value` (query).",
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: {
              grant: { type: "string", description: "Single-use setup grant token (sksg_…)" },
              token: { type: "string", description: "Bearer token (auth_type: bearer)" },
              username: { type: "string", description: "Username (auth_type: basic)" },
              password: { type: "string", description: "Password (auth_type: basic)" },
              header_name: { type: "string", description: "Header name (auth_type: header)" },
              header_value: { type: "string", description: "Header value (auth_type: header)" },
              query_name: {
                type: "string",
                description: "Query parameter name (auth_type: query)",
              },
              query_value: {
                type: "string",
                description: "Query parameter value (auth_type: query)",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Credential saved (HTML thank-you page)",
      content: { "text/html": { schema: z.string() } },
    },
    400: {
      description:
        "Grant missing/invalid/expired/replayed, or a required form field is missing (HTML error page)",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

const draftCredentialSetupFormRoute = createRoute({
  method: "get",
  path: "/v1/connector-drafts/{id}/credentials/setup",
  tags: ["connectors"],
  summary: "Browser-openable credential form for an unsaved connector draft",
  request: { params: IdParam, query: CredentialSetupGrantQuery },
  responses: {
    200: { description: "OK (HTML form)", content: { "text/html": { schema: z.string() } } },
    400: {
      description: "Grant invalid, expired, or already used",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

const draftCredentialSetupSubmitRoute = createRoute({
  method: "post",
  path: "/v1/connector-drafts/{id}/credentials/setup",
  tags: ["connectors"],
  summary: "Submit a credential for an unsaved connector draft",
  request: {
    params: IdParam,
    body: {
      description: "Single-use HTML credential form submission.",
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: {
              grant: { type: "string" },
              token: { type: "string" },
              username: { type: "string" },
              password: { type: "string" },
              header_name: { type: "string" },
              header_value: { type: "string" },
              query_name: { type: "string" },
              query_value: { type: "string" },
              access_key_id: { type: "string" },
              secret_access_key: { type: "string" },
              session_token: { type: "string" },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Credential staged for the draft probe",
      content: { "text/html": { schema: z.string() } },
    },
    400: {
      description: "Grant or credential input invalid",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

// Per-auth_type form fields, parameterized with the (pre-escaped) connector
// label so every secret field names the external service that issued it —
// operators otherwise misread the form as a sign-in for this page.
const AUTH_TYPE_FIELD_HTML: Record<string, (safeName: string) => string> = {
  bearer: (safeName) =>
    `<label>API token / bearer token issued by ${safeName}<br /><input type="password" name="token" required autocomplete="off" autofocus /></label>`,
  basic: (safeName) =>
    `<label>Username for ${safeName}<br /><input type="text" name="username" required autocomplete="off" autofocus /></label>` +
    `<label>Password for ${safeName}<br /><input type="password" name="password" required autocomplete="off" /></label>`,
  header: (safeName) =>
    '<label>Header name<br /><input type="text" name="header_name" required autocomplete="off" autofocus /></label>' +
    `<label>Header value issued by ${safeName}<br /><input type="password" name="header_value" required autocomplete="off" /></label>`,
  query: (safeName) =>
    '<label>Query parameter name<br /><input type="text" name="query_name" required autocomplete="off" autofocus /></label>' +
    `<label>Query parameter value issued by ${safeName}<br /><input type="password" name="query_value" required autocomplete="off" /></label>`,
  aws_sigv4: (safeName) =>
    `<label>Access key ID for ${safeName}<br /><input type="text" name="access_key_id" required autocomplete="off" autofocus /></label>` +
    `<label>Secret access key for ${safeName}<br /><input type="password" name="secret_access_key" required autocomplete="off" /></label>` +
    '<label>Session token (optional)<br /><input type="password" name="session_token" autocomplete="off" /></label>',
};

/**
 * Render the credential-setup form. The plaintext grant token is placed ONLY
 * in the hidden `grant` field so the browser round-trips it on submit — it
 * must never appear anywhere else in this response.
 */
function buildCredentialSetupFormHtml(opts: {
  action: string;
  label: string;
  auth_type: string;
  grant: string;
  mode: "connect" | "reconnect";
}): string {
  const { auth_type, grant } = opts;
  const safeAction = escapeHtml(opts.action);
  const safeName = escapeHtml(opts.label);
  const safeGrant = escapeHtml(grant);
  const fields = AUTH_TYPE_FIELD_HTML[auth_type]?.(safeName) ?? "";
  const heading = opts.mode === "connect" ? `Connect ${safeName}` : `Reconnect ${safeName}`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${heading}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fafafa; color: #111; }
    main { max-width: 480px; margin: 96px auto; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p.sub { color: #555; margin: 0 0 24px; }
    label { display: block; margin: 0 0 16px; font-size: 14px; color: #333; }
    input { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
    button { padding: 10px 18px; font-size: 14px; border: none; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    <p class="sub">Paste the credential issued by ${safeName} below — the secret from that service, not a sign-in for this page. No login is needed here: opening this single-use link from your chat already authorized it. The secret is stored encrypted and never shared with the assistant.</p>
    <form method="POST" action="${safeAction}">
      <input type="hidden" name="grant" value="${safeGrant}" />
      ${fields}
      <button type="submit">Save credential</button>
    </form>
  </main>
</body>
</html>`;
}

export function registerCredentialsSetupRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(draftCredentialSetupFormRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { grant } = c.req.valid("query");
    const validated = await validateDraftCredentialSetup(db, {
      conversation_id: id,
      grant,
    });
    if (!validated) {
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Setup link expired",
        message:
          "This credential-setup link was already used or has expired — ask the assistant for a fresh link.",
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }
    const html = buildCredentialSetupFormHtml({
      action: `/v1/connector-drafts/${id}/credentials/setup`,
      label: validated.connector_label,
      auth_type: validated.auth_type,
      grant,
      mode: "connect",
    });
    return c.body(html, 200, { "content-type": "text/html; charset=utf-8" });
  });

  app.openapi(draftCredentialSetupSubmitRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const form = await parseFormBody(c.req.raw);
    const grant = form.get("grant") ?? "";
    const validated = grant
      ? await validateDraftCredentialSetup(db, { conversation_id: id, grant })
      : null;
    if (!validated) {
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Setup link expired",
        message:
          "This credential-setup link was already used or has expired — ask the assistant for a fresh link.",
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }

    try {
      let credential: Parameters<typeof setDraftCredential>[1];
      switch (validated.auth_type) {
        case "bearer": {
          const token = (form.get("token") ?? "").trim();
          if (!token) throw new MissingFieldError("token");
          credential = { mode: "bearer", token };
          break;
        }
        case "basic": {
          const username = form.get("username") ?? "";
          const password = form.get("password") ?? "";
          if (!username || !password) throw new MissingFieldError("username/password");
          credential = { mode: "basic", username, password };
          break;
        }
        case "header": {
          const header_name = (form.get("header_name") ?? "").trim();
          const header_value = (form.get("header_value") ?? "").trim();
          if (!header_name || !header_value) {
            throw new MissingFieldError("header_name/header_value");
          }
          credential = { mode: "header", header_name, header_value };
          break;
        }
        case "query": {
          const param = form.get("query_name") ?? "";
          const value = form.get("query_value") ?? "";
          if (!param || !value) throw new MissingFieldError("query_name/query_value");
          credential = { mode: "query", param, value };
          break;
        }
        case "aws_sigv4": {
          const access_key_id = form.get("access_key_id") ?? "";
          const secret_access_key = form.get("secret_access_key") ?? "";
          const session_token = form.get("session_token") ?? "";
          if (!access_key_id || !secret_access_key) {
            throw new MissingFieldError("access_key_id/secret_access_key");
          }
          credential = {
            mode: "aws_sigv4",
            access_key_id,
            secret_access_key,
            ...(session_token ? { session_token } : {}),
          };
          break;
        }
      }

      const claim = {
        tenant_id: validated.tenant_id,
        conversation_id: validated.conversation_id,
        elicitation_id: validated.elicitation_id,
      };
      if (!(await claimDraftCredentialNativeUrlElicitation(claim, db))) {
        const { html, status } = buildCallbackPageHtml({
          kind: "error",
          title: "Setup link expired",
          message: "This credential-setup link has already been used.",
        });
        return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
      }

      try {
        await auditAwait(
          {
            tenant_id: validated.tenant_id,
            actor_type: "system",
            actor_id: null,
            action: AuditAction.CONNECTOR_CREDENTIAL_GRANT_CONSUMED,
            resource_type: "conversation",
            resource_id: validated.conversation_id,
            result: "success",
            metadata: {
              draft_only: true,
              auth_type: validated.auth_type,
              elicitation_id: validated.elicitation_id,
            },
          },
          db,
        );
        setDraftCredential(validated.conversation_id, credential);
        if (!(await completeDraftCredentialNativeUrlElicitation(claim, db))) {
          throw new Error("Credential setup completion lost its single-use claim.");
        }
      } catch (err) {
        clearDraftCredential(validated.conversation_id);
        await releaseDraftCredentialNativeUrlElicitation(claim, db);
        throw err;
      }

      logger.info({
        module: "credentials_setup",
        action: "credentials_setup.draft.submit.success",
        msg: "credential staged for connector-draft probe",
        tenant_id: validated.tenant_id,
        conversation_id: validated.conversation_id,
        auth_type: validated.auth_type,
      });
      const { html, status } = buildCallbackPageHtml({
        kind: "success",
        title: "Credential received",
        message:
          `The credential for "${validated.connector_label}" is ready for its live probe. ` +
          "You can close this tab and return to the assistant.",
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    } catch (err) {
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Could not accept credential",
        message: err instanceof Error ? err.message : String(err),
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }
  });

  // ── GET /v1/connectors/{id}/credentials/setup?grant=sksg_… ────────────────
  // Unauthenticated browser-grant path. VALIDATES ONLY — does not consume.
  app.openapi(credentialSetupFormRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { grant } = c.req.valid("query");

    const validated = await validateSetupGrant(db, { token: grant, connector_id: id });
    if (!validated) {
      // Do not echo the grant token in HTML or logs.
      logger.warn({
        module: "credentials_setup",
        action: "credentials_setup.form.invalid_grant",
        msg: "setup grant not found, expired, or wrong connector — browser opened an invalid link",
        connector_id: id,
      });
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Setup link expired",
        message:
          "This credential-setup link was already used or has expired — ask the assistant for a fresh link.",
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }

    // Tenant is derived ONLY from the validated row — never from the request.
    const connector = await connectorSvc.getConnector(
      validated.tenant_id,
      validated.connector_id,
      db,
    );
    if (!connector) {
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Connector not found",
        message: "The connector for this link no longer exists.",
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }

    const html = buildCredentialSetupFormHtml({
      action: `/v1/connectors/${connector.id}/credentials/setup`,
      label: connector.display_name || connector.slug,
      auth_type: connector.auth_type,
      grant,
      mode: "reconnect",
    });
    return c.body(html, 200, { "content-type": "text/html; charset=utf-8" });
  });

  // ── POST /v1/connectors/{id}/credentials/setup ────────────────────────────
  // Form-encoded body (an HTML <form> POST). The route spec documents the
  // body without a zod schema, so no body validator runs — parseFormBody plus
  // the per-mode field checks below stay the boundary validation and every
  // failure renders HTML, not the JSON defaultHook.
  app.openapi(credentialSetupSubmitRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const form = await parseFormBody(c.req.raw);
    const grant = form.get("grant") ?? "";

    if (!grant) {
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Missing setup link token",
        message: "This form was opened without a valid link — ask the assistant for a fresh one.",
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }

    // Atomic claim: wrong connector_id does NOT burn the grant.
    const claimed = await consumeSetupGrant(db, { token: grant, connector_id: id });
    if (!claimed) {
      logger.warn({
        module: "credentials_setup",
        action: "credentials_setup.submit.invalid_grant",
        msg: "setup grant not found, expired, or wrong connector at submit time",
        connector_id: id,
      });
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Setup link expired",
        message:
          "This credential-setup link was already used or has expired — ask the assistant for a fresh link.",
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }

    const { tenant_id, connector_id, created_by_actor_id } = claimed;

    try {
      const connector = await connectorSvc.getConnector(tenant_id, connector_id, db);
      if (!connector) {
        const { html, status } = buildCallbackPageHtml({
          kind: "error",
          title: "Connector not found",
          message: "The connector for this link no longer exists.",
        });
        return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
      }

      let value: Parameters<typeof credsvc.upsertCredential>[0]["value"];
      switch (connector.auth_type) {
        case "bearer": {
          const token = (form.get("token") ?? "").trim();
          if (!token) throw new MissingFieldError("token");
          value = { mode: "bearer", token };
          break;
        }
        case "basic": {
          const username = form.get("username") ?? "";
          const password = form.get("password") ?? "";
          if (!username || !password) throw new MissingFieldError("username/password");
          value = { mode: "basic", username, password };
          break;
        }
        case "header": {
          const headerName = (form.get("header_name") ?? "").trim();
          const headerValue = (form.get("header_value") ?? "").trim();
          if (!headerName || !headerValue) throw new MissingFieldError("header_name/header_value");
          value = { mode: "header", headers: { [headerName]: headerValue } };
          break;
        }
        case "query": {
          const queryName = form.get("query_name") ?? "";
          const queryValue = form.get("query_value") ?? "";
          if (!queryName || !queryValue) throw new MissingFieldError("query_name/query_value");
          value = { mode: "query", query: { [queryName]: queryValue } };
          break;
        }
        default: {
          const { html, status } = buildCallbackPageHtml({
            kind: "error",
            title: "Unsupported credential type",
            message: `Connector '${connector.slug}' uses auth_type '${connector.auth_type}', which this form does not support.`,
          });
          return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
        }
      }

      await credsvc.upsertCredential(
        {
          tenant_id,
          connector_id,
          environment: connector.environment,
          mode: connector.auth_type as "bearer" | "basic" | "header" | "query",
          value,
          // Anonymous browser hit — no operator principal. The grant's
          // created_by_actor_id records who REQUESTED the fix, not who
          // submitted the browser form (the credential service writes
          // `actor_type: "system"` for a null actor_id).
          actor_id: null,
          source: "credential_setup_grant",
        },
        db,
      );

      await clearConnectorReauth(db, tenant_id, connector_id, {
        actor_id: created_by_actor_id,
      });

      try {
        await markConnectorNativeUrlElicitationsComplete(
          { tenant_id, connector_id, outcome: "succeeded" },
          db,
        );
      } catch (completionErr) {
        logger.warn({
          module: "credentials_setup",
          action: "credentials_setup.elicitation_completion_failed",
          msg: "credential saved but native MCP URL completion could not be recorded",
          tenant_id,
          connector_id,
          error: completionErr instanceof Error ? completionErr.message : String(completionErr),
        });
      }

      logger.info({
        module: "credentials_setup",
        action: "credentials_setup.submit.success",
        msg: "credential persisted via credential-setup grant",
        tenant_id,
        connector_id,
      });

      const { html, status } = buildCallbackPageHtml({
        kind: "success",
        title: "Credential saved",
        message: `Connector "${connector.display_name ?? connector.slug}" is reconnected. You can close this tab and return to the assistant.`,
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "credentials_setup",
        action: "credentials_setup.submit.failed",
        msg: "credential-setup form submission failed after the grant was consumed",
        tenant_id,
        connector_id,
        error: message,
      });
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Could not save credential",
        message: `${message}\n\nThis link has been used up — ask the assistant for a fresh one.`,
      });
      return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
    }
  });
}

class MissingFieldError extends Error {
  constructor(field: string) {
    super(`missing required field(s): ${field}`);
  }
}
