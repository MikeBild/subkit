import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH_UI_DIGEST,
  authHtmlResponse,
  BROWSER_TITLE,
  localeCookie,
  type PageLook,
  renderApiKeyLogin,
  renderConsentPage,
  renderErrorPage,
  renderInvalidReturnPage,
  renderNotFoundPage,
  renderProviderChoice,
  renderServerErrorPage,
  renderUnavailablePage,
  resolveAuthLocale,
  resolvePageLook,
  type SignInError,
  wantsHtmlPage,
} from "./ui.ts";

const CONTRACT_PATH = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "contract");
const CONTRACT = readFileSync(join(CONTRACT_PATH, "cockpit-ui.css"));
const CONTRACT_TEXT = CONTRACT.toString("utf8");

function region(name: string): string {
  const match = CONTRACT_TEXT.match(
    new RegExp(`/\\* cockpit-ui:begin ${name} \\*/\\n([\\s\\S]*?)/\\* cockpit-ui:end ${name} \\*/`),
  );
  if (!match?.[1]) throw new Error(`contract region ${name} missing`);
  return match[1];
}

function styleOf(html: string): string {
  return html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
}

const DE: PageLook = { locale: "de", scheme: null };
const EN: PageLook = { locale: "en", scheme: null };

const SIGN_IN_ERRORS: SignInError[] = [
  "state_expired",
  "grant_denied",
  "authorize_invalid",
  "provider_not_configured",
  "tenant_unavailable",
  "provider_unavailable",
];

function consent(look: PageLook, clientUri: string | null = null) {
  return renderConsentPage({
    clientName: "Probe Service",
    clientUri,
    tenantName: "Example",
    userEmail: "operator@example.com",
    offeredScopes: ["mcp:read", "mcp:authoring"],
    preChecked: ["mcp:read"],
    csrfToken: "csrf",
    state: "state",
    clientId: "client",
    redirectUri: "https://probe.example/callback",
    resource: "",
    look,
  });
}

const PROVIDERS = [
  { id: "api-key", protocol: "api_key" as const, href: "/api-key" },
  { id: "workforce", protocol: "oidc" as const, href: "/workforce" },
];

const RENDERERS: Record<string, (look: PageLook) => string> = {
  providerChoice: (look) => renderProviderChoice(PROVIDERS, look),
  apiKeyLogin: (look) => renderApiKeyLogin("/v1/identity/login/start", "api-key", "s", "", look),
  consent: (look) => consent(look, "https://probe.example"),
  ...Object.fromEntries(
    SIGN_IN_ERRORS.map((error) => [
      `error:${error}`,
      (look: PageLook) => renderErrorPage(error, "/v1/identity/login/start", look),
    ]),
  ),
  notFound: (look) => renderNotFoundPage(look),
  serverError: (look) => renderServerErrorPage(look, "4bf92f3577b34da6a3ce929d0e0e4736"),
  loginMissing: (look) => renderUnavailablePage(look, "login"),
  cockpitMissing: (look) => renderUnavailablePage(look, "cockpit"),
  invalidReturn: (look) => renderInvalidReturnPage(look),
};

const NOT_COPY = new Set([
  "SubKit",
  "OAuth 2.1",
  "Engine",
  "Probe Service",
  "Example",
  "operator@example.com",
  "https://probe.example",
  "mcp:read",
  "mcp:authoring",
  "4bf92f3577b34da6a3ce929d0e0e4736",
]);

function visibleText(html: string): string[] {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .split(/<[^>]+>/)
    .flatMap((text) => text.split(/\s+·\s+|:\s+/))
    .map((text) => text.replace(/[.:]$/, "").trim())
    .filter((text) => text.length > 1 && !NOT_COPY.has(text));
}

describe("one design source", () => {
  test("serves the contract's token regions byte for byte, never a copy", () => {
    const style = styleOf(renderProviderChoice(PROVIDERS, EN));
    expect(style).toContain(region("tokens-light"));
    expect(style).toContain(region("tokens-dark"));
    expect(style).toContain(`:root {\n${region("theme-map")}}`);
    const dark = region("tokens-dark");
    const declarations = dark.slice(dark.indexOf("{") + 1, dark.lastIndexOf("}"));
    expect(style).toContain(`:root:not(.light) {${declarations}}`);
    const outside = style
      .replace(region("tokens-light"), "")
      .replace(region("tokens-dark"), "")
      .replace(declarations, "");
    expect(outside.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });

  test("announces the digest of the contract bytes it renders", () => {
    const html = renderNotFoundPage(EN);
    const digest = createHash("sha256").update(CONTRACT).digest("base64");
    expect(html).toContain(`<meta name="cockpit-ui-digest" content="sha256-${digest}">`);
    expect(html).toContain(`<meta name="mcp-auth-ui-contract" content="${AUTH_UI_DIGEST}">`);
  });

  test("the single page is a 420px card with no shadow and the cockpit's button geometry", () => {
    const style = styleOf(renderNotFoundPage(EN));
    expect(style).toContain(".card{width:min(420px,100%)");
    expect(style).toContain("border-radius:16px");
    expect(style).not.toContain("box-shadow");
    expect(style).toContain("h1{font-size:24px;line-height:32px;font-weight:600");
    expect(style).toContain("font-size:14px;line-height:20px");
    expect(style).toContain(
      ".button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px",
    );
    expect(style).toContain(".button.primary:hover{opacity:.9}");
  });

  for (const [name, render] of Object.entries(RENDERERS)) {
    test(`${name} has one title, one surface, the word mark and the cockpit browser title`, () => {
      const html = render(DE);
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
      expect(html.match(/data-family-surface="/g)?.length).toBe(1);
      expect(html).toContain('data-family-slot="product-identity"');
      expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/cockpit/favicon.svg">');
      expect(html).toContain(`<title>${BROWSER_TITLE}</title>`);
      expect(BROWSER_TITLE).toBe("SubKit Cockpit");
      expect(html).not.toContain("<script");
    });
  }
});

describe("language and theme follow the cockpit", () => {
  test("the cockpit's cookies win over the browser's headers", () => {
    const headers = new Headers({
      cookie: "subkit_session=x; sk_locale=de; sk_theme=dark",
      "accept-language": "en-US,en;q=0.9",
    });
    expect(resolvePageLook(headers)).toEqual({ locale: "de", scheme: "dark" });
  });

  test("without a cookie the browser's language decides and the scheme stays the system's", () => {
    expect(resolvePageLook(new Headers({ "accept-language": "de-DE,de;q=0.9" }))).toEqual({
      locale: "de",
      scheme: null,
    });
    expect(resolvePageLook(new Headers())).toEqual({ locale: "en", scheme: null });
  });

  test("an unknown cookie value is no preference", () => {
    const headers = new Headers({
      cookie: "sk_locale=klingon; sk_theme=system; other=%E0%A4%A",
      "accept-language": "de",
    });
    expect(resolvePageLook(headers)).toEqual({ locale: "de", scheme: null });
  });

  test("lang and the scheme class are set by the server", () => {
    expect(renderNotFoundPage({ locale: "de", scheme: "dark" })).toContain(
      '<html lang="de" class="dark">',
    );
    expect(renderNotFoundPage({ locale: "en", scheme: "light" })).toContain(
      '<html lang="en" class="light">',
    );
    expect(renderNotFoundPage(EN)).toContain('<html lang="en">\n');
  });

  test("the locale cookie is readable by the cockpit and same-site", () => {
    expect(localeCookie("de", true)).toBe(
      "sk_locale=de; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(localeCookie("en", false)).not.toContain("HttpOnly");
    expect(localeCookie("en", false)).not.toContain("Secure");
  });

  test("Accept-Language ranges resolve to the two supported languages", () => {
    expect(resolveAuthLocale("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(resolveAuthLocale("fr-FR,fr;q=0.9")).toBe("en");
  });
});

describe("every page speaks German when the reader does", () => {
  for (const [name, render] of Object.entries(RENDERERS)) {
    test(`${name} renders no English copy for de`, () => {
      const german = render(DE);
      const english = visibleText(render(EN));
      expect(english.length).toBeGreaterThan(0);
      expect(english.filter((text) => german.includes(text))).toEqual([]);
    });
  }
});

describe("pages without a way back are dead ends", () => {
  test("404 and 500 lead to the cockpit with exactly one link", () => {
    for (const html of [renderNotFoundPage(DE), renderServerErrorPage(DE, "abc")]) {
      expect(html.match(/<a\s/g)?.length).toBe(1);
      expect(html).toContain('href="/cockpit"');
      expect(html).toContain(">Zum Cockpit</a>");
    }
    expect(renderNotFoundPage(EN)).toContain(">Back to Cockpit</a>");
  });

  test("the 500 page names its reference so a person can quote it", () => {
    const html = renderServerErrorPage(DE, "<trace>");
    expect(html).toContain("Etwas ist schiefgelaufen");
    expect(html).toContain("&lt;trace&gt;");
    expect(html).toContain('value="&lt;trace&gt;" readonly');
    expect(html).toContain('data-family-surface="fatal-error"');
    expect(renderNotFoundPage(DE)).toContain('data-family-surface="not-found"');
    expect(renderNotFoundPage(DE)).toContain("Diese Seite gibt es nicht");
  });

  test("an installation without sign-in or cockpit points at the engine's start page", () => {
    for (const part of ["login", "cockpit"] as const) {
      const html = renderUnavailablePage(DE, part);
      expect(html.match(/<a\s/g)?.length).toBe(1);
      expect(html).toContain('href="/"');
    }
  });

  test("only a browser asks for a page", () => {
    expect(wantsHtmlPage("text/html,application/xhtml+xml")).toBe(true);
    expect(wantsHtmlPage("application/json")).toBe(false);
    expect(wantsHtmlPage(undefined)).toBe(false);
  });
});

describe("sign-in pages", () => {
  test("consent is escaped, script-free and request-bounded", () => {
    const html = renderConsentPage({
      clientName: "<script>bad</script>",
      tenantName: "Example",
      userEmail: "operator@example.com",
      offeredScopes: ["mcp:read"],
      preChecked: ["mcp:read"],
      csrfToken: "csrf",
      state: "state",
      clientId: "client",
      redirectUri: "https://client.example/callback",
      resource: "",
      look: EN,
    });
    expect(html).toContain('data-auth-contract="mcp-auth"');
    expect(html).toContain('data-family-surface="auth"');
    expect(html).toContain('value="mcp:read" checked disabled');
    expect(html).toContain('value="switch_account"');
    expect(html).not.toContain("<script>bad</script>");
    expect(html).not.toContain("mcp:admin");
    const response = authHtmlResponse(html);
    expect(response.headers.get("cache-control")).toBe("private,no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
  });

  test("consent in German names the decision Freigeben and Ablehnen", () => {
    const html = consent(DE, "https://probe.example");
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Zugriff freigeben");
    expect(html).toContain('möchte auf <span class="strong">Example</span> zugreifen');
    expect(html).toContain('data-testid="auth-client-uri"');
    expect(html).toContain('value="approve" class="button primary">Freigeben<');
    expect(html).toContain('value="deny" class="button outline">Ablehnen<');
    expect(html).toContain("Bearbeiten · mcp:authoring");
    expect(consent(EN)).not.toContain("auth-client-uri");
    expect(consent(EN)).toContain("Authorize access");
  });

  test("the provider chooser puts SSO first and carries the family identity", () => {
    const html = renderProviderChoice(PROVIDERS, DE);
    expect(html.indexOf('data-auth-provider="sso"')).toBeLessThan(
      html.indexOf('data-auth-provider="api-key"'),
    );
    expect(html).toContain('data-family-slot="provider-actions"');
    expect(html).toContain('data-auth-product="subkit"');
    expect(html).toContain('data-testid="auth-product-icon"');
    expect(html).toContain("Bei SubKit anmelden");
    expect(html).toContain("SubKit · OAuth 2.1");
    expect(html).toContain("Du bist abgemeldet. Wähle, wie du dich bei SubKit anmeldest.");
    const companyProvider =
      '<a class="button primary" href="/workforce" data-auth-provider="sso" data-testid="auth-provider-sso">Mit Firmenkonto anmelden</a>';
    const apiKeyProvider =
      '<a class="button outline" href="/api-key" data-auth-provider="api-key" data-testid="auth-provider-api-key">Mit API-Schlüssel anmelden</a>';
    expect(html).toContain(companyProvider);
    expect(html).toContain(apiKeyProvider);
    expect(html.indexOf(companyProvider)).toBeLessThan(html.indexOf(apiKeyProvider));
    const english = renderProviderChoice(PROVIDERS, EN);
    expect(english.indexOf("Sign in with work account")).toBeLessThan(
      english.indexOf("Sign in with API key"),
    );
    expect(english).toContain("You are signed out. Choose how to sign in to SubKit.");
  });

  test("a failed sign-in offers one retry in the reader's language", () => {
    const html = renderErrorPage("state_expired", "/v1/identity/login/start", DE);
    expect(html).toContain("Anmeldung fehlgeschlagen");
    expect(html).toContain('href="/v1/identity/login/start"');
    expect(html).toContain(">Erneut anmelden</a>");
    expect(html.match(/<a\s/g)?.length).toBe(1);
    const english = renderErrorPage("grant_denied", "/v1/identity/login/start", EN);
    expect(english).toContain("Sign-in failed");
    expect(english).toContain("Your account is not authorized for SubKit. Contact the operator.");
    expect(english).toContain(">Sign in again</a>");
    const response = authHtmlResponse(html, 400);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("the retry address is escaped", () => {
    const html = renderErrorPage("state_expired", '"><script>x</script>', EN);
    expect(html).not.toContain("<script>x</script>");
  });
});

test("API key sign-in returns to the same authorization attempt and retains escaped state", () => {
  const html = renderApiKeyLogin(
    "/v1/identity/login/start",
    "api-key",
    "state&value",
    undefined,
    DE,
  );
  expect(html).toContain("Mit API-Schlüssel anmelden");
  expect(html).toContain('href="/v1/identity/login/start?login_state=state%26value"');
  expect(html).toContain('name="login_state" value="state&amp;value"');
  expect(html).toContain(">Anmelden</button>");
  expect(html).toContain(
    '<a class="button outline" href="/v1/identity/login/start?login_state=state%26value" data-testid="auth-api-key-back">Zurück</a>',
  );
});

test("an unassigned company account has its own error outcome", () => {
  const unassigned = renderErrorPage("account_not_assigned", "/v1/identity/login/start", DE);
  expect(unassigned.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(unassigned).toContain('<h1 data-family-slot="auth-heading">Konto nicht zugeordnet</h1>');
  expect(unassigned).toContain('class="stack" role="alert"');
  expect(unassigned).toContain(
    "Dieses Firmenkonto ist SubKit nicht zugeordnet. Frag eine Person mit der Rolle Administrator.",
  );
  expect(unassigned).toContain(
    '<a class="button primary" href="/v1/identity/login/start" data-testid="auth-retry">Erneut anmelden</a>',
  );
  expect(unassigned).not.toContain("Anmeldung fehlgeschlagen");

  const denied = renderErrorPage("grant_denied", "/v1/identity/login/start", DE);
  expect(denied).toContain('<h1 data-family-slot="auth-heading">Anmeldung fehlgeschlagen</h1>');
  expect(denied).toContain(
    "Dein Konto ist für SubKit nicht freigegeben. Frag eine Person mit der Rolle Administrator.",
  );
  expect(denied).not.toContain("Konto nicht zugeordnet");

  const unassignedEnglish = renderErrorPage("account_not_assigned", "/v1/identity/login/start", EN);
  expect(unassignedEnglish).toContain(
    '<h1 data-family-slot="auth-heading">Account not assigned</h1>',
  );
  expect(unassignedEnglish).toContain(
    "This company account is not assigned to SubKit. Contact an administrator.",
  );
  expect(unassignedEnglish).not.toContain("Sign-in failed");
});
