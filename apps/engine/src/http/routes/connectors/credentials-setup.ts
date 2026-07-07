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
//        (grant-token auth). Form-encoded body — cannot be expressed cleanly
//        via @hono/zod-openapi (same precedent as the MCP OAuth consent
//        decision and token endpoints in http/routes/oauth/{consent,token}.ts).
//        Atomically consumes the grant, upserts the credential, clears
//        needs_reauth, and renders a thank-you HTML page. Invalid/expired/
//        replayed grant → 400 HTML.
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
import * as connectorSvc from "../../../connectors/index.ts";
import {
  buildCallbackPageHtml,
  clearConnectorReauth,
  consumeSetupGrant,
  escapeHtml,
  validateSetupGrant,
} from "../../../connectors/index.ts";
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

const AUTH_TYPE_FIELD_HTML: Record<string, string> = {
  bearer:
    '<label>API token / bearer token<br /><input type="password" name="token" required autocomplete="off" autofocus /></label>',
  basic:
    '<label>Username<br /><input type="text" name="username" required autocomplete="off" autofocus /></label>' +
    '<label>Password<br /><input type="password" name="password" required autocomplete="off" /></label>',
  header:
    '<label>Header name<br /><input type="text" name="header_name" required autocomplete="off" autofocus /></label>' +
    '<label>Header value<br /><input type="password" name="header_value" required autocomplete="off" /></label>',
  query:
    '<label>Query parameter name<br /><input type="text" name="query_name" required autocomplete="off" autofocus /></label>' +
    '<label>Query parameter value<br /><input type="password" name="query_value" required autocomplete="off" /></label>',
};

/**
 * Render the credential-setup form. The plaintext grant token is placed ONLY
 * in the hidden `grant` field so the browser round-trips it on submit — it
 * must never appear anywhere else in this response.
 */
function buildCredentialSetupFormHtml(opts: {
  connector: { id: string; slug: string; display_name: string; auth_type: string };
  grant: string;
}): string {
  const { connector, grant } = opts;
  const action = `/v1/connectors/${connector.id}/credentials/setup`;
  const safeName = escapeHtml(connector.display_name || connector.slug);
  const safeGrant = escapeHtml(grant);
  const fields = AUTH_TYPE_FIELD_HTML[connector.auth_type] ?? "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reconnect ${safeName}</title>
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
    <h1>Reconnect ${safeName}</h1>
    <p class="sub">Enter the new credential below. This link is single-use and expires shortly.</p>
    <form method="POST" action="${action}">
      <input type="hidden" name="grant" value="${safeGrant}" />
      ${fields}
      <button type="submit">Save credential</button>
    </form>
  </main>
</body>
</html>`;
}

export function registerCredentialsSetupRoutes(app: OpenAPIHono<AppEnv>): void {
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
        title: "Sign-in link expired",
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

    const html = buildCredentialSetupFormHtml({ connector, grant });
    return c.body(html, 200, { "content-type": "text/html; charset=utf-8" });
  });

  // ── POST /v1/connectors/{id}/credentials/setup ────────────────────────────
  // Raw handler — form-encoded body (an HTML <form> POST). Cannot be
  // expressed cleanly via @hono/zod-openapi; same precedent as
  // http/routes/oauth/{consent,token}.ts. The body is still validated at the
  // boundary — see the per-mode field checks below.
  app.post("/v1/connectors/:id/credentials/setup", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const form = await parseFormBody(c.req.raw);
    const grant = form.get("grant") ?? "";

    if (!grant) {
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Missing sign-in link token",
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
        title: "Sign-in link expired",
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
          const token = form.get("token") ?? "";
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
          const headerName = form.get("header_name") ?? "";
          const headerValue = form.get("header_value") ?? "";
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
