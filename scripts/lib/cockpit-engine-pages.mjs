import {
  BROWSER_TITLE,
  renderApiKeyLogin,
  renderConsentPage,
  renderErrorPage,
  renderInvalidReturnPage,
  renderNotFoundPage,
  renderProviderChoice,
  renderResultPage,
  renderServerErrorPage,
  renderUnavailablePage,
} from "../../apps/engine/src/http/routes/oauth/ui.ts";
import {
  approvalStatusPage,
  buildApprovalDecisionHtml,
} from "../../apps/engine/src/http/routes/tool-approval-ui.ts";
import FAMILY_UI from "../../FAMILY-UI.json" with { type: "json" };
import { familyGeometry } from "./cockpit-family-geometry.mjs";

const PORTAL_VIEW = {
  approval_id: "approval",
  tenant_id: "tenant",
  tool: "wf_contact-notify",
  workflow_slug: "contact-notify",
  surface: "slack",
  execution_mode: "prod",
  expires_at: new Date(Date.UTC(2030, 0, 1, 18)),
  state: "pending",
  preview: null,
};

export function enginePages(look) {
  return [
    {
      name: "sign-in",
      primaries: 1,
      html: renderProviderChoice(
        [
          { id: "sso", protocol: "oidc", href: "/v1/identity/login/sso" },
          { id: "api-key", protocol: "api_key", href: "/v1/identity/login/api-key" },
        ],
        look,
      ),
    },
    {
      name: "sign-in-key",
      primaries: 1,
      html: renderApiKeyLogin("/v1/identity/login", "api-key", "state", undefined, look),
    },
    {
      name: "sign-in-failed",
      primaries: 1,
      links: 1,
      html: renderErrorPage("state_expired", "/v1/identity/cockpit-login", look),
    },
    {
      name: "consent",
      primaries: 1,
      html: renderConsentPage({
        clientName: "Claude",
        clientUri: "https://claude.example",
        tenantName: "Acme",
        userEmail: "operator@example.com",
        offeredScopes: ["mcp:read", "mcp:run"],
        preChecked: ["mcp:read"],
        csrfToken: "csrf",
        state: "state",
        clientId: "client",
        redirectUri: "https://claude.example/callback",
        resource: "https://sk.example.com/mcp",
        look,
      }),
    },
    {
      name: "sign-in-result",
      primaries: 1,
      links: 1,
      html: renderResultPage(
        {
          kind: "success",
          title: look.locale === "de" ? "Verbunden" : "Connected",
          lines: [look.locale === "de" ? "Gmail ist angemeldet." : "Gmail is signed in."],
          cockpitHref: "/cockpit/connectors",
          context: "OAuth 2.1",
        },
        look,
      ),
    },
    { name: "not-found", primaries: 1, links: 1, html: renderNotFoundPage(look) },
    {
      name: "server-error",
      primaries: 1,
      links: 1,
      html: renderServerErrorPage(look, "req_7f3a9c2e"),
    },
    { name: "unavailable", primaries: 1, links: 1, html: renderUnavailablePage(look, "login") },
    { name: "invalid-return", primaries: 1, links: 1, html: renderInvalidReturnPage(look) },
    {
      name: "portal-decision",
      primaries: 1,
      html: buildApprovalDecisionHtml(
        PORTAL_VIEW,
        "grant",
        { email: "operator@example.com" },
        "csrf",
        look,
      ),
    },
    {
      name: "portal-status",
      primaries: 1,
      links: 1,
      html: approvalStatusPage(
        look,
        look.locale === "de" ? "Abgelehnt" : "Declined",
        look.locale === "de" ? "Die Aktion findet nicht statt." : "The action does not take place.",
      ).html,
    },
  ];
}

function measure() {
  const shown = (node) => node.getClientRects().length > 0;
  const heading = document.querySelector("main h1");
  const style = heading ? getComputedStyle(heading) : null;
  const card = document.querySelector("main.card");
  const control = [...document.querySelectorAll("main .button, main button")].find(shown);
  return {
    lang: document.documentElement.getAttribute("lang"),
    scheme: document.documentElement.className,
    title: document.title,
    heading: style
      ? {
          size: Number.parseFloat(style.fontSize),
          line: Number.parseFloat(style.lineHeight),
          weight: Number(style.fontWeight),
        }
      : null,
    radius: card ? Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) : null,
    shadow: card ? getComputedStyle(card).boxShadow : null,
    control: control ? Math.round(control.getBoundingClientRect().height) : null,
    primaries: [...document.querySelectorAll("main .primary")].filter(shown).length,
    links: [...document.querySelectorAll("main a[href]")].filter(shown).length,
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
}

export function enginePageBreaches(page, measured, look, expected = familyGeometry()) {
  const breaches = [];
  if (measured.lang !== look.locale)
    breaches.push(`lang ${measured.lang} instead of ${look.locale}`);
  if (!measured.scheme.split(/\s+/).includes(look.scheme))
    breaches.push(`theme class "${measured.scheme}" lacks ${look.scheme}`);
  if (measured.title !== BROWSER_TITLE)
    breaches.push(`title "${measured.title}" instead of "${BROWSER_TITLE}"`);
  if (!measured.heading) breaches.push("no page title");
  else
    for (const key of ["size", "line", "weight"])
      if (measured.heading[key] !== expected.pageTitle[key])
        breaches.push(
          `title ${key} ${measured.heading[key]} instead of ${expected.pageTitle[key]}`,
        );
  if (measured.radius !== FAMILY_UI.geometry.cardRadiusPx)
    breaches.push(
      `card radius ${measured.radius}px instead of ${FAMILY_UI.geometry.cardRadiusPx}px`,
    );
  if (FAMILY_UI.visualLanguage.shadow === "none" && measured.shadow && measured.shadow !== "none")
    breaches.push(`card shadow "${measured.shadow}"`);
  if (measured.control !== null && measured.control !== expected.controlHeight)
    breaches.push(`control ${measured.control}px instead of ${expected.controlHeight}px`);
  if (measured.primaries !== page.primaries)
    breaches.push(`${measured.primaries} primary actions instead of ${page.primaries}`);
  if (page.links !== undefined && measured.links !== page.links)
    breaches.push(`${measured.links} links instead of ${page.links}`);
  if (measured.wide) breaches.push("scrolls sideways");
  return breaches;
}

export async function verifyEnginePages(page, look, label, capture) {
  for (const engine of enginePages(look)) {
    await page.setContent(engine.html, { waitUntil: "load" });
    const breaches = enginePageBreaches(engine, await page.evaluate(measure), look);
    if (breaches.length > 0)
      throw new Error(
        `${label}/engine-${engine.name} leaves the cockpit design: ${breaches.join("; ")}`,
      );
    await capture(engine.name);
  }
}
