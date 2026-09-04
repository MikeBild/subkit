// Shared, script-free OAuth UI contract used by the SubKit MCP authorization server.

import { createHash } from "node:crypto";
import { escapeHtml } from "./shared.ts";

const AUTH_CONTRACT = "mcp-auth";

const TOKENS = `
  /*mcp-auth:begin*/
  :root{color-scheme:light dark;--background:#ffffff;--foreground:#020817;--card:#ffffff;--muted:#f1f5f9;--muted-foreground:#64748b;--primary:#0f172a;--primary-foreground:#f8fafc;--primary-hover:#020817;--border:#e2e8f0;--input:#e2e8f0;--destructive:#dc2626;--ring:#2563eb;--radius:12px;--radius-md:calc(var(--radius)*.8);--radius-lg:var(--radius);--radius-xl:calc(var(--radius)*1.4);--shadow:0 10px 30px rgba(2,8,23,.08)}
  @media(prefers-color-scheme:dark){:root:not(.scheme-light){color-scheme:dark;--background:#020817;--foreground:#f8fafc;--card:#0f172a;--muted:#1e293b;--muted-foreground:#94a3b8;--primary:#f8fafc;--primary-foreground:#0f172a;--primary-hover:#ffffff;--border:#334155;--input:#334155;--destructive:#f87171;--ring:#60a5fa;--shadow:0 10px 30px rgba(0,0,0,.5)}}
  :root.scheme-light{color-scheme:light}:root.scheme-dark{color-scheme:dark;--background:#020817;--foreground:#f8fafc;--card:#0f172a;--muted:#1e293b;--muted-foreground:#94a3b8;--primary:#f8fafc;--primary-foreground:#0f172a;--primary-hover:#ffffff;--border:#334155;--input:#334155;--destructive:#f87171;--ring:#60a5fa;--shadow:0 10px 30px rgba(0,0,0,.5)}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;padding:24px;display:flex;align-items:center;justify-content:center;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--background);color:var(--foreground)}
  :focus-visible{outline:2px solid var(--ring);outline-offset:2px}
  .card{background:var(--card);width:100%;max-width:420px;border:1px solid var(--border);border-radius:var(--radius-xl);box-shadow:var(--shadow);padding:32px}
  .brand{display:block;width:42px;height:42px;border-radius:var(--radius-lg);object-fit:cover;margin:0 0 20px}
  h1{font-size:1.2rem;line-height:1.3;margin:0 0 8px}p{margin:0 0 10px;line-height:1.5}.muted{color:var(--muted-foreground);font-size:.9rem}.strong{font-weight:600}.error{color:var(--destructive)}
  ul.scopes{list-style:none;margin:18px 0 4px;padding:0}ul.scopes li{padding:12px 14px;margin-bottom:8px;background:var(--muted);border:1px solid var(--border);border-radius:var(--radius-md)}.provider-stack{display:grid;gap:10px;margin-top:20px}
  .scope-row{display:flex;align-items:flex-start;gap:10px;cursor:pointer}.scope-row input[type=checkbox]{margin-top:2px;flex:none;accent-color:var(--primary)}.scope-text{display:flex;flex-direction:column;gap:2px}.scope-name{font-weight:600;font-size:.92rem}.scope-desc{color:var(--muted-foreground);font-size:.85rem}
  label.field{display:block;margin:16px 0 0;font-size:.9rem;font-weight:600}input[type=password]{width:100%;margin-top:6px;padding:11px 12px;border:1px solid var(--input);border-radius:var(--radius-md);background:var(--card);color:var(--foreground);font:inherit}
  .actions{display:flex;gap:10px;margin-top:22px}button,.button{flex:1;min-height:44px;padding:11px 18px;display:flex;align-items:center;justify-content:center;font-size:.95rem;font-weight:600;cursor:pointer;border-radius:var(--radius-md);border:1px solid transparent;font-family:inherit;text-align:center;text-decoration:none}.provider-stack .button{width:100%}.approve{background:var(--primary);color:var(--primary-foreground)}.approve:hover{background:var(--primary-hover)}.deny{background:var(--card);color:var(--foreground);border-color:var(--input)}.deny:hover{background:var(--muted)}
  .switch{display:block;margin:16px auto 0;padding:0;border:0;background:transparent;color:var(--muted-foreground);font-size:.82rem;text-decoration:underline;cursor:pointer}.footer{margin-top:20px;color:var(--muted-foreground);font-size:.78rem;text-align:center}@media(max-width:480px){body{padding:12px}.card{padding:24px}.actions{flex-direction:column-reverse}}
  /*mcp-auth:end*/
`;

/**
 * The contract marker, derived from the bytes it describes.
 *
 * It used to be a hand-typed `content="2"`, in four repositories. Four products
 * can all claim version 2 while their CSS quietly diverges — a marker that could
 * not be wrong because it said nothing about the bytes. This one is computed from
 * TOKENS, so two products serving different CSS announce different strings, in
 * the DOM, in every screenshot. There is no version to keep in step because there
 * is no version: the bytes are the identity.
 */
export const AUTH_UI_DIGEST = `sha256-${createHash("sha256").update(sharedRegion(TOKENS)).digest("hex").slice(0, 12)}`;

/** The bytes between the sentinels — what the family shares, not what this file contains. */
function sharedRegion(css: string): string {
  return css.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? "";
}

export type AuthLocale = "de" | "en";

export function resolveAuthLocale(acceptLanguage: string | undefined): AuthLocale {
  for (const range of acceptLanguage?.split(",") ?? []) {
    const language = range.trim().split(";", 1)[0]?.toLowerCase();
    if (language === "de" || language?.startsWith("de-")) return "de";
    if (language === "en" || language?.startsWith("en-")) return "en";
  }
  return "en";
}

function page(title: string, body: string, locale: AuthLocale = "en"): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="mcp-auth-ui-contract" content="${AUTH_UI_DIGEST}">
  <link rel="icon" type="image/svg+xml" href="/cockpit/favicon.svg">
  <title>${escapeHtml(title)} — SubKit</title>
  <style>${TOKENS}</style>
</head>
<body><main class="card" data-auth-contract="${AUTH_CONTRACT}" data-auth-product="subkit" data-testid="auth-page"><img class="brand" src="/cockpit/favicon.svg" alt="" data-testid="auth-product-icon">${body}<div class="footer" data-family-slot="auth-meta">SubKit · OAuth 2.1</div></main></body>
</html>`;
}

export function authHtmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private,no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

export const SIGN_IN_FAILED_TITLE = "Sign-in failed";
export const STATE_ERROR_MESSAGE =
  "This sign-in attempt expired or was already used. Please sign in again.";
export const GRANT_DENIED_MESSAGE =
  "Your account is not authorized for SubKit. Contact the operator.";
export const AUTHORIZE_INVALID_MESSAGE =
  "This authorization request is invalid. Return to the application and start the sign-in again.";

export function renderErrorPage(title: string, message: string, retryHref: string): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p><div class="actions"><a class="button approve" href="${escapeHtml(retryHref)}">Sign in again</a></div>`,
  );
}

export interface LoginProviderChoice {
  id: string;
  protocol: "api_key" | "oidc";
  href: string;
}

export function renderProviderChoice(
  providers: LoginProviderChoice[],
  locale: AuthLocale = "en",
): string {
  const links = [...providers]
    .sort(
      (left, right) => Number(left.protocol === "api_key") - Number(right.protocol === "api_key"),
    )
    .map((provider) => {
      const apiKey = provider.protocol === "api_key";
      const label =
        locale === "de"
          ? apiKey
            ? "Mit API-Schlüssel fortfahren"
            : "Mit SSO fortfahren"
          : apiKey
            ? "Continue with API key"
            : "Continue with SSO";
      return `<a class="button ${apiKey ? "deny" : "approve"}" data-auth-provider="${apiKey ? "api-key" : "sso"}" data-testid="auth-provider-${apiKey ? "api-key" : "sso"}" href="${escapeHtml(provider.href)}">${label}</a>`;
    })
    .join("");
  return page(
    locale === "de" ? "Anmelden" : "Sign in",
    `<h1 data-family-slot="auth-heading">${locale === "de" ? "Bei SubKit anmelden" : "Sign in to SubKit"}</h1><p class="muted">${locale === "de" ? "Wähle die Anmeldung für SubKit." : "Choose how to sign in to SubKit."}</p><div class="provider-stack" data-family-slot="provider-actions">${links}</div>`,
    locale,
  );
}

export function renderApiKeyLogin(
  action: string,
  providerId: string,
  state: string,
  error?: string,
  locale: AuthLocale = "en",
): string {
  return page(
    locale === "de" ? "Anmelden" : "Sign in",
    `<h1 data-family-slot="auth-heading">${locale === "de" ? "Bei SubKit anmelden" : "Sign in to SubKit"}</h1><p class="muted">${locale === "de" ? "Verwende einen bereichsgebundenen SubKit API-Schlüssel." : "Use a scoped SubKit API key."}</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}<form method="POST" action="${escapeHtml(action)}"><input type="hidden" name="provider" value="${escapeHtml(providerId)}"><input type="hidden" name="login_state" value="${escapeHtml(state)}"><label class="field">${locale === "de" ? "API-Schlüssel" : "API key"}<input type="password" name="api_key" autocomplete="current-password" required></label><div class="actions"><button class="approve" type="submit">${locale === "de" ? "Fortfahren" : "Continue"}</button></div></form>`,
    locale,
  );
}

export function renderConsentPage(opts: {
  clientName: string;
  /** The client's own base address from its registration (RFC 7591 `client_uri`), when it gave one. */
  clientUri?: string | null;
  tenantName: string;
  userEmail: string;
  offeredScopes: string[];
  preChecked: string[];
  csrfToken: string;
  state: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  locale?: AuthLocale;
}): string {
  const locale = opts.locale ?? "en";
  const de = locale === "de";
  // What each scope lets the client do, in the person's language. The
  // scope's machine name stays beside it: it is what the client asked for,
  // and what the audit row will say.
  const labels: Record<string, [string, string]> = de
    ? {
        "mcp:read": ["Lesen", "Veröffentlichte Inhalte, Ressourcen und Kennzahlen lesen"],
        "mcp:authoring": ["Bearbeiten", "Entwürfe, Versionen und Vorschauen anlegen"],
        "mcp:admin": ["Verwalten", "Freigaben erteilen und Zugriff verwalten"],
        "metrics:read": ["Betriebszähler", "Betriebszähler lesen — sonst nichts"],
      }
    : {
        "mcp:read": ["Read", "Read published content, resources and product statistics"],
        "mcp:authoring": ["Authoring", "Create drafts, revisions and previews"],
        "mcp:admin": ["Administration", "Publish releases and administer access"],
        "metrics:read": ["Operational counters", "Read the operational counters — nothing else"],
      };
  const checked = new Set(opts.preChecked);
  const scopeItems = opts.offeredScopes
    .map((scope) => {
      const value = escapeHtml(scope);
      const [name, description] = labels[scope] ?? [scope, scope];
      const required = scope === "mcp:read";
      return `<li><label class="scope-row"><input type="checkbox" name="scope" value="${value}"${required || checked.has(scope) ? " checked" : ""}${required ? " disabled" : ""}><span class="scope-text"><span class="scope-name">${escapeHtml(name)} · ${value}</span><span class="scope-desc">${escapeHtml(description)}</span></span></label>${required ? `<input type="hidden" name="scope" value="${value}">` : ""}</li>`;
    })
    .join("");
  const hidden = `<input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}"><input type="hidden" name="client_id" value="${escapeHtml(opts.clientId)}"><input type="hidden" name="redirect_uri" value="${escapeHtml(opts.redirectUri)}"><input type="hidden" name="resource" value="${escapeHtml(opts.resource)}"><input type="hidden" name="state" value="${escapeHtml(opts.state)}">`;
  const clientUri = opts.clientUri
    ? `<p class="muted" data-testid="auth-client-uri">${de ? "Adresse" : "Address"}: <span class="strong">${escapeHtml(opts.clientUri)}</span></p>`
    : "";
  const title = de ? "Zugriff freigeben" : "Authorize access";
  const asks = de
    ? `<span class="strong">${escapeHtml(opts.clientName)}</span> möchte auf <span class="strong">${escapeHtml(opts.tenantName)}</span> zugreifen.`
    : `<span class="strong">${escapeHtml(opts.clientName)}</span> is requesting access to <span class="strong">${escapeHtml(opts.tenantName)}</span>.`;
  const signedIn = de ? "Angemeldet als" : "Signed in as";
  const can = de ? "Es darf dann:" : "It will be able to:";
  const deny = de ? "Ablehnen" : "Deny";
  const approve = de ? "Freigeben" : "Approve";
  const switchAccount = de ? "Anderes Konto verwenden" : "Use another account";
  return page(
    title,
    `<h1>${title}</h1><p>${asks}</p>${clientUri}<p class="muted">${signedIn} ${escapeHtml(opts.userEmail)}</p><p class="muted">${can}</p><form method="POST" action="/v1/oauth/authorize/decision"><ul class="scopes">${scopeItems}</ul>${hidden}<div class="actions"><button name="decision" value="deny" class="deny">${deny}</button><button name="decision" value="approve" class="approve">${approve}</button></div><button name="decision" value="switch_account" class="switch">${switchAccount}</button></form>`,
    locale,
  );
}
