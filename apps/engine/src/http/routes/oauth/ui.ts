import { createHash } from "node:crypto";
import contractCss from "../../../../../../contract/cockpit-ui.css" with { type: "text" };
import { escapeHtml } from "./shared.ts";

const AUTH_CONTRACT = "mcp-auth";
const PRODUCT_NAME = "SubKit";
export const BROWSER_TITLE = `${PRODUCT_NAME} Cockpit`;
export const LOCALE_COOKIE = "sk_locale";
export const THEME_COOKIE = "sk_theme";
const PREFERENCE_MAX_AGE = 60 * 60 * 24 * 365;

export type AuthLocale = "de" | "en";
export type PageScheme = "light" | "dark";

export interface PageLook {
  locale: AuthLocale;
  scheme: PageScheme | null;
}

export function contractRegion(css: string, name: string): string {
  const begin = `/* cockpit-ui:begin ${name} */\n`;
  const end = `/* cockpit-ui:end ${name} */`;
  const start = css.indexOf(begin);
  const stop = start < 0 ? -1 : css.indexOf(end, start);
  if (start < 0 || stop < 0) throw new Error(`cockpit-ui region ${name} is missing`);
  return css.slice(start + begin.length, stop);
}

const TOKENS_LIGHT = contractRegion(contractCss, "tokens-light");
const TOKENS_DARK = contractRegion(contractCss, "tokens-dark");
const THEME_MAP = contractRegion(contractCss, "theme-map");
const DARK_DECLARATIONS = TOKENS_DARK.slice(
  TOKENS_DARK.indexOf("{") + 1,
  TOKENS_DARK.lastIndexOf("}"),
);

export const COCKPIT_UI_DIGEST = `sha256-${createHash("sha256").update(contractCss).digest("base64")}`;

const SINGLE_PAGE = `
:root{color-scheme:light;--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
:root.dark{color-scheme:dark}
@media (prefers-color-scheme: dark){:root:not(.light){color-scheme:dark}}
*{box-sizing:border-box}html,body{margin:0}h1,h2,h3,p,dl,dd,ul,pre{margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:32px 16px;background:var(--muted);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:20px;-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.card{width:min(420px,100%);display:grid;gap:16px;padding:24px;border:1px solid var(--border);border-radius:16px;background:var(--background);min-width:0;overflow-wrap:anywhere}
.card.wide{width:min(640px,100%)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600}.brand img{width:28px;height:28px;border-radius:var(--radius-md)}
.head{display:grid;gap:4px;min-width:0}.title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
h1{font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.02em}h2{font-size:16px;line-height:24px;font-weight:600}h3{font-size:14px;line-height:20px;font-weight:600}
.eyebrow{font-size:12px;line-height:16px;font-weight:500;color:var(--muted-foreground)}
.muted{color:var(--muted-foreground)}.strong{font-weight:600}.error{color:var(--destructive);font-size:13px}
.mono{font-family:var(--font-mono);font-size:12.5px;overflow-wrap:anywhere}
.stack{display:grid;gap:12px;min-width:0}ul.plain{list-style:none;margin:0;padding:0}
.note{padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface);color:var(--muted-foreground)}
.reference{display:flex;align-items:center;min-height:36px;padding:0 12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface)}
.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.actions.stack{display:grid;justify-content:stretch}.actions.stack .button{width:100%}
.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 10px;border-radius:var(--radius-lg);border:1px solid transparent;background:none;color:var(--foreground);font:inherit;font-size:14px;line-height:20px;font-weight:500;white-space:nowrap;text-decoration:none;cursor:pointer}
.button.primary{background:var(--primary);color:var(--primary-foreground)}.button.primary:hover{opacity:.9}
.button.outline{border-color:var(--border);background:var(--background)}.button.outline:hover,.button.ghost:hover{background:var(--muted)}
.button[aria-pressed=true]{background:var(--muted)}
.link{padding:0;border:0;background:none;color:var(--muted-foreground);font:inherit;font-size:13px;text-decoration:underline;cursor:pointer;justify-self:center}
.chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border:1px solid var(--border);border-radius:999px;background:var(--background);font-size:12px;font-weight:500;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:999px;flex:none;background:var(--muted-foreground)}.dot.warning{background:var(--warning)}.dot.success{background:var(--success)}.dot.destructive{background:var(--destructive)}.dot.accent{background:var(--accent)}
form{display:grid;gap:16px;margin:0}
label.field{display:grid;gap:6px;font-weight:500}
input[type=password],input[type=text]{width:100%;height:36px;padding:0 12px;border:1px solid var(--input);border-radius:var(--radius-md);background:var(--background);color:var(--foreground);font:inherit}
ul.scopes{list-style:none;display:grid;gap:8px;margin:0;padding:0}ul.scopes li{padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface)}
.scope-row{display:flex;align-items:flex-start;gap:10px;cursor:pointer}.scope-row input{margin-top:3px;flex:none;accent-color:var(--primary)}.scope-text{display:grid;gap:2px}.scope-name{font-weight:500}.scope-desc{color:var(--muted-foreground);font-size:13px}
.facts{display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.facts dt,.facts dd{padding:10px 14px;border-top:1px solid var(--border);min-width:0}.facts dt:first-of-type,.facts dt:first-of-type+dd{border-top:0}
.facts dt{color:var(--muted-foreground)}.facts dd{font-weight:500;overflow-wrap:anywhere}
details{border:1px solid var(--border);border-radius:var(--radius)}details summary{cursor:pointer;padding:10px 14px;font-weight:500}details>div{display:grid;gap:12px;padding:14px;border-top:1px solid var(--border)}
pre.payload{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;border-radius:var(--radius-md);background:var(--muted);font-family:var(--font-mono);font-size:12.5px;line-height:20px}
.foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--border);font-size:12px;line-height:16px;color:var(--muted-foreground)}
.foot form{display:flex;gap:4px}.foot .button{height:24px;padding:0 8px;font-size:12px}
@media (max-width:639px){body{place-items:start center;padding:16px}.card{padding:20px}.actions .button{flex:1}.facts{grid-template-columns:1fr}.facts dt+dd{border-top:0;padding-top:0}}
`;

const STYLES = `/*mcp-auth:begin*/
${TOKENS_LIGHT}${TOKENS_DARK}@media (prefers-color-scheme: dark) {
:root:not(.light) {${DARK_DECLARATIONS}}
}
:root {
${THEME_MAP}}
${SINGLE_PAGE}/*mcp-auth:end*/`;

export const AUTH_UI_STYLES = STYLES;

export const AUTH_UI_DIGEST = `sha256-${createHash("sha256").update(sharedRegion(STYLES)).digest("hex").slice(0, 12)}`;

function sharedRegion(css: string): string {
  return css.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? "";
}

export function resolveAuthLocale(acceptLanguage: string | null | undefined): AuthLocale {
  for (const range of acceptLanguage?.split(",") ?? []) {
    const language = range.trim().split(";", 1)[0]?.toLowerCase();
    if (language === "de" || language?.startsWith("de-")) return "de";
    if (language === "en" || language?.startsWith("en-")) return "en";
  }
  return "en";
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function resolvePageLook(headers: Headers): PageLook {
  const cookie = headers.get("cookie");
  const locale = cookieValue(cookie, LOCALE_COOKIE);
  const theme = cookieValue(cookie, THEME_COOKIE);
  return {
    locale:
      locale === "de" || locale === "en"
        ? locale
        : resolveAuthLocale(headers.get("accept-language")),
    scheme: theme === "light" || theme === "dark" ? theme : null,
  };
}

export function localeCookie(locale: AuthLocale, secure: boolean): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${PREFERENCE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function wantsHtmlPage(accept: string | null | undefined): boolean {
  return (accept ?? "").includes("text/html");
}

export type PageSurface = "auth" | "not-found" | "fatal-error";

export interface SinglePage {
  look: PageLook;
  surface: PageSurface;
  body: string;
  context: string;
  wide?: boolean;
  footer?: string;
  attributes?: string;
}

const SURFACE_ATTRIBUTES: Record<PageSurface, string> = {
  auth: ` data-auth-contract="${AUTH_CONTRACT}" data-auth-product="subkit" data-testid="auth-page"`,
  "not-found": ' data-testid="single-page"',
  "fatal-error": ' data-testid="single-page"',
};

export function renderSinglePage(page: SinglePage): string {
  const scheme = page.look.scheme ? ` class="${page.look.scheme}"` : "";
  return `<!doctype html>
<html lang="${page.look.locale}"${scheme}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light dark">
  <meta name="cockpit-ui-contract" content="cockpit-ui">
  <meta name="cockpit-ui-digest" content="${COCKPIT_UI_DIGEST}">
  <meta name="mcp-auth-ui-contract" content="${AUTH_UI_DIGEST}">
  <link rel="icon" type="image/svg+xml" href="/cockpit/favicon.svg">
  <title>${BROWSER_TITLE}</title>
  <style>${STYLES}</style>
</head>
<body><main class="card${page.wide ? " wide" : ""}" data-family-surface="${page.surface}"${SURFACE_ATTRIBUTES[page.surface]}${page.attributes ?? ""}><div class="brand" data-family-slot="product-identity"><img src="/cockpit/favicon.svg" alt="" data-testid="auth-product-icon"><span>${PRODUCT_NAME}</span></div>${page.body}<footer class="foot" data-family-slot="auth-meta"><span>${PRODUCT_NAME} · ${escapeHtml(page.context)}</span>${page.footer ?? ""}</footer></main></body>
</html>`;
}

export type ChipTone = "warning" | "success" | "destructive" | "accent";

export interface PageHead {
  title: string;
  slot: string;
  line?: string | null;
  lineHtml?: string;
  eyebrow?: string | null;
  chip?: { tone: ChipTone; word: string } | null;
}

export function pageHead(head: PageHead): string {
  const eyebrow = head.eyebrow ? `<p class="eyebrow">${escapeHtml(head.eyebrow)}</p>` : "";
  const chip = head.chip
    ? `<span class="chip" data-testid="page-status"><span class="dot ${head.chip.tone}"></span>${escapeHtml(head.chip.word)}</span>`
    : "";
  const line = head.lineHtml
    ? `<p class="muted">${head.lineHtml}</p>`
    : head.line
      ? `<p class="muted">${escapeHtml(head.line)}</p>`
      : "";
  return `<div class="head">${eyebrow}<div class="title"><h1 data-family-slot="${head.slot}">${escapeHtml(head.title)}</h1>${chip}</div>${line}</div>`;
}

export function pageActions(html: string, opts: { stack?: boolean; slot?: string } = {}): string {
  const slot = opts.slot ? ` data-family-slot="${opts.slot}"` : "";
  return `<div class="actions${opts.stack ? " stack" : ""}"${slot}>${html}</div>`;
}

export function linkButton(
  href: string,
  label: string,
  variant: "primary" | "outline",
  attributes = "",
): string {
  return `<a class="button ${variant}" href="${escapeHtml(href)}"${attributes}>${escapeHtml(label)}</a>`;
}

const PAGE_COPY: Record<
  AuthLocale,
  {
    cockpit: string;
    start: string;
    signInTitle: string;
    signInHeading: string;
    signInFailed: string;
    signInAgain: string;
    oauthContext: string;
  }
> = {
  en: {
    cockpit: "Back to Cockpit",
    start: "To the start page",
    signInTitle: "Sign in",
    signInHeading: "Sign in to SubKit",
    signInFailed: "Sign-in failed",
    signInAgain: "Sign in again",
    oauthContext: "OAuth 2.1",
  },
  de: {
    cockpit: "Zum Cockpit",
    start: "Zur Startseite",
    signInTitle: "Anmelden",
    signInHeading: "Bei SubKit anmelden",
    signInFailed: "Anmeldung fehlgeschlagen",
    signInAgain: "Erneut anmelden",
    oauthContext: "OAuth 2.1",
  },
};

export const COCKPIT_HOME = "/cockpit";

export function cockpitLink(locale: AuthLocale, href: string = COCKPIT_HOME): string {
  return linkButton(href, PAGE_COPY[locale].cockpit, "primary", ' data-testid="page-cockpit-link"');
}

export interface ResultPage {
  kind: "success" | "error";
  title: string;
  lines: readonly string[];
  command?: string | null;
  cockpitHref: string;
  context: string;
}

export function renderResultPage(result: ResultPage, look: PageLook): string {
  const [statement = "", ...rest] = result.lines;
  const qualifiers = rest.map((line) => `<p class="muted">${escapeHtml(line)}</p>`).join("");
  const command = result.command
    ? `<p class="mono" data-testid="auth-result-command">${escapeHtml(result.command)}</p>`
    : "";
  const alert = result.kind === "error" ? ' role="alert"' : "";
  return renderSinglePage({
    look,
    surface: "auth",
    context: result.context,
    body: `<div class="stack" data-testid="auth-result" data-result-kind="${result.kind}"${alert}>${pageHead({ title: result.title, slot: "auth-heading", line: statement })}${qualifiers}${command}</div>${pageActions(cockpitLink(look.locale, result.cockpitHref))}`,
  });
}

export const HTML_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private,no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const;

export const NEGOTIATED_VARY = "Accept, Cookie";

export function authHtmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { ...HTML_PAGE_HEADERS } });
}

export function negotiatedPageResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: { ...HTML_PAGE_HEADERS, vary: NEGOTIATED_VARY } });
}

export type SignInError =
  | "state_expired"
  | "grant_denied"
  | "account_not_assigned"
  | "registration_closed"
  | "authorize_invalid"
  | "provider_not_configured"
  | "tenant_unavailable"
  | "provider_unavailable";

const SIGN_IN_ERRORS: Record<AuthLocale, Record<SignInError, string>> = {
  en: {
    state_expired: "This sign-in attempt expired or was already used. Please sign in again.",
    account_not_assigned:
      "This company account is not assigned to SubKit. Contact an administrator.",
    registration_closed:
      "New SubKit workspaces are currently unavailable. Contact an administrator.",
    grant_denied: "Your account is not authorized for SubKit. Contact the operator.",
    authorize_invalid:
      "This authorization request is invalid. Return to the application and start the sign-in again.",
    provider_not_configured: "This sign-in provider is not configured. Contact the operator.",
    tenant_unavailable:
      "This sign-in provider is not available for this tenant. Please sign in again.",
    provider_unavailable: "The sign-in provider is temporarily unavailable. Please try again.",
  },
  de: {
    state_expired:
      "Dieser Anmeldeversuch ist abgelaufen oder wurde schon verwendet. Melde dich erneut an.",
    account_not_assigned:
      "Dieses Firmenkonto ist SubKit nicht zugeordnet. Frag eine Person mit der Rolle Administrator.",
    registration_closed:
      "Neue SubKit-Arbeitsbereiche sind derzeit nicht verfügbar. Frag eine Person mit der Rolle Administrator.",
    grant_denied:
      "Dein Konto ist für SubKit nicht freigegeben. Frag eine Person mit der Rolle Administrator.",
    authorize_invalid:
      "Diese Autorisierungsanfrage ist ungültig. Kehre zur Anwendung zurück und starte die Anmeldung dort neu.",
    provider_not_configured:
      "Dieser Anmeldeanbieter ist nicht eingerichtet. Frag eine Person mit der Rolle Administrator.",
    tenant_unavailable:
      "Dieser Anmeldeanbieter steht für diesen Mandanten nicht bereit. Melde dich erneut an.",
    provider_unavailable:
      "Der Anmeldeanbieter ist gerade nicht erreichbar. Versuche es gleich noch einmal.",
  },
};

export function renderErrorPage(error: SignInError, retryHref: string, look: PageLook): string {
  const copy = PAGE_COPY[look.locale];
  const title =
    error === "account_not_assigned"
      ? look.locale === "de"
        ? "Konto nicht zugeordnet"
        : "Account not assigned"
      : error === "registration_closed"
        ? look.locale === "de"
          ? "Registrierung geschlossen"
          : "Registration closed"
        : copy.signInFailed;
  return renderSinglePage({
    look,
    surface: "auth",
    context: copy.oauthContext,
    body: `<div class="stack" role="alert">${pageHead({ title, slot: "auth-heading", line: SIGN_IN_ERRORS[look.locale][error] })}</div>${pageActions(linkButton(retryHref, copy.signInAgain, "primary", ' data-testid="auth-retry"'))}`,
  });
}

export interface LoginProviderChoice {
  id: string;
  protocol: "api_key" | "oidc";
  href: string;
}

export function renderProviderChoice(providers: LoginProviderChoice[], look: PageLook): string {
  const de = look.locale === "de";
  const links = [...providers]
    .sort(
      (left, right) => Number(left.protocol === "api_key") - Number(right.protocol === "api_key"),
    )
    .map((provider) => {
      const apiKey = provider.protocol === "api_key";
      const label = de
        ? apiKey
          ? "Mit API-Schlüssel anmelden"
          : "Mit Firmenkonto anmelden"
        : apiKey
          ? "Sign in with API key"
          : "Sign in with work account";
      const kind = apiKey ? "api-key" : "sso";
      return linkButton(
        provider.href,
        label,
        apiKey ? "outline" : "primary",
        ` data-auth-provider="${kind}" data-testid="auth-provider-${kind}"`,
      );
    })
    .join("");
  const copy = PAGE_COPY[look.locale];
  return renderSinglePage({
    look,
    surface: "auth",
    context: copy.oauthContext,
    body: `${pageHead({ title: copy.signInHeading, slot: "auth-heading", line: de ? "Du bist abgemeldet. Wähle, wie du dich bei SubKit anmeldest." : "You are signed out. Choose how to sign in to SubKit." })}${pageActions(links, { stack: true, slot: "provider-actions" })}`,
  });
}

export function renderApiKeyLogin(
  action: string,
  providerId: string,
  state: string,
  error: string | undefined,
  look: PageLook,
): string {
  const de = look.locale === "de";
  const copy = PAGE_COPY[look.locale];
  return renderSinglePage({
    look,
    surface: "auth",
    context: copy.oauthContext,
    body: `${pageHead({ title: de ? "Mit API-Schlüssel anmelden" : "Sign in with API key", slot: "auth-heading", line: de ? "Verwende einen bereichsgebundenen SubKit API-Schlüssel." : "Use a scoped SubKit API key." })}<form method="POST" action="${escapeHtml(action)}"><input type="hidden" name="provider" value="${escapeHtml(providerId)}"><input type="hidden" name="login_state" value="${escapeHtml(state)}"><label class="field">${de ? "API-Schlüssel" : "API key"}<input type="password" name="api_key" autocomplete="current-password" required></label>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}${pageActions(`<button class="button primary" type="submit">${de ? "Anmelden" : "Sign in"}</button>`)}</form>${pageActions(linkButton(`/v1/identity/login/start?login_state=${encodeURIComponent(state)}`, de ? "Zurück" : "Back", "outline", ' data-testid="auth-api-key-back"'))}`,
  });
}

export function renderConsentPage(opts: {
  clientName: string;
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
  look: PageLook;
}): string {
  const de = opts.look.locale === "de";
  const labels: Record<string, [string, string]> = de
    ? {
        "mcp:read": ["Lesen", "Veröffentlichte Inhalte, Ressourcen und Kennzahlen lesen"],
        "mcp:authoring": ["Bearbeiten", "Entwürfe, Versionen und Vorschauen anlegen"],
        "mcp:admin": ["Verwalten", "Freigaben erteilen und Zugriff verwalten"],
        "metrics:read": ["Betriebszähler", "Betriebszähler lesen — sonst nichts"],
        "sk:login": ["CLI-Anmeldung", "Einen persönlichen Schlüssel für die SubKit CLI ausstellen"],
      }
    : {
        "mcp:read": ["Read", "Read published content, resources and product statistics"],
        "mcp:authoring": ["Authoring", "Create drafts, revisions and previews"],
        "mcp:admin": ["Administration", "Publish releases and administer access"],
        "metrics:read": ["Operational counters", "Read the operational counters — nothing else"],
        "sk:login": ["CLI sign-in", "Issue a personal key for the SubKit CLI"],
      };
  const checked = new Set(opts.preChecked);
  const scopeItems = opts.offeredScopes
    .map((scope) => {
      const value = escapeHtml(scope);
      const [name, description] = labels[scope] ?? [scope, scope];
      const required = scope === "mcp:read" || scope === "sk:login";
      return `<li><label class="scope-row"><input type="checkbox" name="scope" value="${value}"${required || checked.has(scope) ? " checked" : ""}${required ? " disabled" : ""}><span class="scope-text"><span class="scope-name">${escapeHtml(name)} · ${value}</span><span class="scope-desc">${escapeHtml(description)}</span></span></label>${required ? `<input type="hidden" name="scope" value="${value}">` : ""}</li>`;
    })
    .join("");
  const hidden = `<input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}"><input type="hidden" name="client_id" value="${escapeHtml(opts.clientId)}"><input type="hidden" name="redirect_uri" value="${escapeHtml(opts.redirectUri)}"><input type="hidden" name="resource" value="${escapeHtml(opts.resource)}"><input type="hidden" name="state" value="${escapeHtml(opts.state)}">`;
  const clientUri = opts.clientUri
    ? `<p class="muted" data-testid="auth-client-uri">${de ? "Adresse" : "Address"}: <span class="strong">${escapeHtml(opts.clientUri)}</span></p>`
    : "";
  const asks = de
    ? `<span class="strong">${escapeHtml(opts.clientName)}</span> möchte auf <span class="strong">${escapeHtml(opts.tenantName)}</span> zugreifen.`
    : `<span class="strong">${escapeHtml(opts.clientName)}</span> is requesting access to <span class="strong">${escapeHtml(opts.tenantName)}</span>.`;
  const signedIn = de ? "Angemeldet als" : "Signed in as";
  const can = de ? "Es darf dann:" : "It will be able to:";
  const deny = de ? "Ablehnen" : "Deny";
  const approve = de ? "Freigeben" : "Approve";
  const switchAccount = de ? "Anderes Konto verwenden" : "Use another account";
  return renderSinglePage({
    look: opts.look,
    surface: "auth",
    context: PAGE_COPY[opts.look.locale].oauthContext,
    body: `${pageHead({ title: de ? "Zugriff freigeben" : "Authorize access", slot: "auth-heading", lineHtml: asks })}${clientUri}<p class="muted">${signedIn} ${escapeHtml(opts.userEmail)}</p><form method="POST" action="/v1/oauth/authorize/decision"><p class="muted">${can}</p><ul class="scopes">${scopeItems}</ul>${hidden}${pageActions(`<button name="decision" value="deny" class="button outline">${deny}</button><button name="decision" value="approve" class="button primary">${approve}</button>`)}<button name="decision" value="switch_account" class="link">${switchAccount}</button></form>`,
  });
}

const NOTICE_COPY: Record<
  AuthLocale,
  {
    notFoundTitle: string;
    notFoundLine: string;
    errorTitle: string;
    errorLine: string;
    reference: string;
    loginMissingTitle: string;
    loginMissingLine: string;
    bundleMissingTitle: string;
    bundleMissingLine: string;
    returnInvalidTitle: string;
    returnInvalidLine: string;
    context: string;
  }
> = {
  en: {
    notFoundTitle: "This page does not exist",
    notFoundLine: "The address is wrong, or the page was removed.",
    errorTitle: "Something went wrong",
    errorLine: "SubKit could not handle the request. Quote this reference if you ask for help.",
    reference: "Reference",
    loginMissingTitle: "Sign-in is not set up",
    loginMissingLine:
      "No sign-in provider is configured for this installation. An administrator has to add one under auth.providers.",
    bundleMissingTitle: "The Cockpit is not included",
    bundleMissingLine:
      "This installation was built without the Cockpit. The API and the sk command-line client keep working.",
    returnInvalidTitle: "This sign-in link is invalid",
    returnInvalidLine:
      "Its return address leads outside the Cockpit. Open the Cockpit and sign in there.",
    context: "Engine",
  },
  de: {
    notFoundTitle: "Diese Seite gibt es nicht",
    notFoundLine: "Die Adresse ist falsch, oder die Seite wurde entfernt.",
    errorTitle: "Etwas ist schiefgelaufen",
    errorLine: "SubKit konnte die Anfrage nicht bearbeiten. Nenne bei Rückfragen diese Kennung.",
    reference: "Kennung",
    loginMissingTitle: "Anmeldung nicht eingerichtet",
    loginMissingLine:
      "Für diese Installation ist kein Anmeldeanbieter eingerichtet. Eine Person mit der Rolle Administrator muss einen unter auth.providers hinterlegen.",
    bundleMissingTitle: "Das Cockpit fehlt",
    bundleMissingLine:
      "Diese Installation wurde ohne das Cockpit gebaut. Die API und die Kommandozeile sk funktionieren weiter.",
    returnInvalidTitle: "Dieser Anmeldelink ist ungültig",
    returnInvalidLine:
      "Seine Rücksprungadresse führt aus dem Cockpit hinaus. Öffne das Cockpit und melde dich dort an.",
    context: "Engine",
  },
};

export function renderNotFoundPage(look: PageLook): string {
  const copy = NOTICE_COPY[look.locale];
  return renderSinglePage({
    look,
    surface: "not-found",
    context: copy.context,
    body: `${pageHead({ title: copy.notFoundTitle, slot: "failure-state", line: copy.notFoundLine })}${pageActions(cockpitLink(look.locale), { slot: "failure-actions" })}`,
  });
}

export function renderServerErrorPage(look: PageLook, reference: string | null): string {
  const copy = NOTICE_COPY[look.locale];
  const shown = reference
    ? `<div class="stack"><p class="muted">${copy.reference}</p><input class="reference mono" data-testid="page-reference" aria-label="${escapeHtml(copy.reference)}" value="${escapeHtml(reference)}" readonly></div>`
    : "";
  return renderSinglePage({
    look,
    surface: "fatal-error",
    context: copy.context,
    body: `${pageHead({ title: copy.errorTitle, slot: "failure-state", line: copy.errorLine })}${shown}${pageActions(cockpitLink(look.locale), { slot: "failure-actions" })}`,
  });
}

export type UnavailablePart = "login" | "cockpit";

export function renderUnavailablePage(look: PageLook, part: UnavailablePart): string {
  const copy = NOTICE_COPY[look.locale];
  const [title, line] =
    part === "login"
      ? [copy.loginMissingTitle, copy.loginMissingLine]
      : [copy.bundleMissingTitle, copy.bundleMissingLine];
  return renderSinglePage({
    look,
    surface: "fatal-error",
    context: copy.context,
    body: `${pageHead({ title, slot: "failure-state", line })}${pageActions(linkButton("/", PAGE_COPY[look.locale].start, "primary", ' data-testid="page-start-link"'), { slot: "failure-actions" })}`,
  });
}

export function renderInvalidReturnPage(look: PageLook): string {
  const copy = NOTICE_COPY[look.locale];
  return renderSinglePage({
    look,
    surface: "auth",
    context: PAGE_COPY[look.locale].oauthContext,
    body: `${pageHead({ title: copy.returnInvalidTitle, slot: "auth-heading", line: copy.returnInvalidLine })}${pageActions(cockpitLink(look.locale))}`,
  });
}
