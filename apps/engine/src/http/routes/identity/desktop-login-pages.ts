import { DESKTOP_LOGIN_CONFIRM_PATH } from "../../../auth/index.ts";
import { escapeHtml } from "../oauth/shared.ts";
import {
  type AuthLocale,
  COCKPIT_HOME,
  type PageLook,
  pageActions,
  pageHead,
  renderSinglePage,
} from "../oauth/ui.ts";

const CONTEXT = "Desktop";

const DESKTOP_STYLES = `
.dl-graphic{display:grid;gap:12px;margin:0;padding:16px;border:1px solid var(--border);border-radius:var(--radius-lg);background:color-mix(in srgb,var(--muted) 45%,transparent)}
.dl-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(12px,40px) auto minmax(12px,40px) minmax(0,1fr);align-items:start}
.dl-node{display:grid;justify-items:center;gap:2px;min-width:0;text-align:center}
.dl-node .dl-tile{margin-bottom:6px}
.dl-sub{font-size:12px;line-height:16px;color:var(--muted-foreground)}
.dl-name{max-width:100%;font-weight:600;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.dl-tile{display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--background);color:var(--foreground)}
.dl-tile svg{width:18px;height:18px}
.dl-tile.via{width:28px;height:28px;margin-top:4px;color:var(--muted-foreground)}.dl-tile.via svg{width:14px;height:14px}
.dl-tile.mark{border-color:transparent;background:var(--foreground);color:var(--background)}
.dl-line{margin-top:17px;border-top:2px dashed var(--border)}
.dl-line.warning{border-top-color:color-mix(in srgb,var(--warning) 70%,transparent)}
.dl-state{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}
.dl-account{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-md)}
.dl-account .mono{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-hero{display:grid;place-items:center;width:48px;height:48px;border-radius:999px;background:var(--muted);color:var(--muted-foreground)}.dl-hero svg{width:22px;height:22px}
details.dl-details{border-radius:var(--radius-md)}details.dl-details summary{padding:8px 12px;font-size:13px;color:var(--muted-foreground)}details.dl-details>div{padding:10px 12px}
.dl-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 16px;margin:0;font-size:12px;line-height:16px}.dl-facts dt{color:var(--muted-foreground)}.dl-facts dd{font-family:var(--font-mono);overflow-wrap:anywhere}
@media (max-width:639px){.dl-graphic{padding:12px}.dl-row{grid-template-columns:minmax(0,1fr) minmax(8px,24px) auto minmax(8px,24px) minmax(0,1fr)}}
`;

const ICON_PATHS = {
  laptop:
    '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  workflow:
    '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
} as const;

type IconName = keyof typeof ICON_PATHS;

function icon(name: IconName): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

function tile(name: IconName, variant = ""): string {
  return `<span class="dl-tile${variant ? ` ${variant}` : ""}" aria-hidden="true">${icon(name)}</span>`;
}

interface GraphicNode {
  icon: IconName;
  mark?: boolean;
  sub: string;
  name: string;
}

function connectionGraphic(opts: {
  from: GraphicNode;
  via: IconName;
  to: GraphicNode;
  tone: "warning" | "neutral";
  label: string;
  state: { tone: "accent" | "warning"; text: string };
  testId: string;
}): string {
  const node = (n: GraphicNode) =>
    `<span class="dl-node">${tile(n.icon, n.mark ? "mark" : "")}<span class="dl-sub">${escapeHtml(n.sub)}</span><span class="dl-name" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span></span>`;
  const line = `<span class="dl-line${opts.tone === "warning" ? " warning" : ""}" aria-hidden="true"></span>`;
  return `<figure class="dl-graphic" data-testid="${opts.testId}"><div class="dl-row" role="img" aria-label="${escapeHtml(opts.label)}">${node(opts.from)}${line}${tile(opts.via, "via")}${line}${node(opts.to)}</div><figcaption class="dl-state"><span class="dot ${opts.state.tone}" aria-hidden="true"></span>${escapeHtml(opts.state.text)}</figcaption></figure>`;
}

function techDetails(locale: AuthLocale, rows: readonly (readonly [string, string])[]): string {
  const summary = locale === "de" ? "Technische Details" : "Technical details";
  const facts = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  return `<details class="dl-details" data-testid="desktop-login-details"><summary>${summary}</summary><div><dl class="dl-facts">${facts}</dl></div></details>`;
}

function browserLink(locale: AuthLocale): string {
  return `<a class="button outline" href="${COCKPIT_HOME}" data-testid="page-cockpit-link">${locale === "de" ? "Im Browser weiterarbeiten" : "Keep working in the browser"}</a>`;
}

function page(look: PageLook, body: string): string {
  return renderSinglePage({
    look,
    surface: "auth",
    context: CONTEXT,
    styles: DESKTOP_STYLES,
    body,
  });
}

export function renderDesktopLoginConfirm(opts: {
  deviceLabel: string;
  tenantName: string;
  userEmail: string;
  requestToken: string;
  csrfToken: string;
  appVersion?: string | undefined;
  look: PageLook;
}): string {
  const de = opts.look.locale === "de";
  const graphic = connectionGraphic({
    from: { icon: "laptop", sub: "SubKit Desktop", name: opts.deviceLabel },
    via: "lock",
    to: {
      icon: "workflow",
      mark: true,
      sub: de ? "Arbeitsbereich" : "Workspace",
      name: opts.tenantName,
    },
    tone: "neutral",
    label: de
      ? `SubKit Desktop auf ${opts.deviceLabel} meldet sich bei ${opts.tenantName} an`
      : `SubKit Desktop on ${opts.deviceLabel} signs in to ${opts.tenantName}`,
    state: {
      tone: "accent",
      text: de ? "Wartet auf deine Bestätigung" : "Waiting for you to confirm",
    },
    testId: "desktop-login-graphic",
  });
  const account = `<div class="dl-account"><span class="muted">${de ? "Konto" : "Account"}</span><span class="mono" title="${escapeHtml(opts.userEmail)}">${escapeHtml(opts.userEmail)}</span></div>`;
  const hidden = `<input type="hidden" name="request" value="${escapeHtml(opts.requestToken)}"><input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}">`;
  const buttons = `<button name="decision" value="deny" class="button outline">${de ? "Abbrechen" : "Cancel"}</button><button name="decision" value="approve" class="button primary">${de ? "Anmelden" : "Sign in"}</button>`;
  const details = opts.appVersion
    ? techDetails(opts.look.locale, [[de ? "App-Version" : "App version", opts.appVersion]])
    : "";
  return page(
    opts.look,
    `${pageHead({
      title: de ? "Bei SubKit Desktop anmelden" : "Sign in to SubKit Desktop",
      slot: "auth-heading",
      line: de
        ? "Bestätige nur, wenn du die Anmeldung gerade selbst in der App gestartet hast."
        : "Confirm only if you just started this sign-in yourself in the app.",
    })}${graphic}${account}<form method="POST" action="${DESKTOP_LOGIN_CONFIRM_PATH}" data-testid="desktop-login-confirm">${hidden}${pageActions(buttons)}</form>${details}`,
  );
}

export function renderDesktopAppOutdated(opts: {
  appVersion: string | undefined;
  minVersion: string;
  look: PageLook;
}): string {
  const de = opts.look.locale === "de";
  const current = opts.appVersion ?? (de ? "unbekannt" : "unknown");
  const required = de ? `ab ${opts.minVersion}` : `${opts.minVersion} or later`;
  const graphic = connectionGraphic({
    from: { icon: "laptop", sub: de ? "Diese App" : "This app", name: current },
    via: "download",
    to: { icon: "workflow", mark: true, sub: de ? "Nötig" : "Required", name: required },
    tone: "warning",
    label: de
      ? `App-Version ${current}, nötig ist Version ${required}`
      : `App version ${current}, version ${required} is required`,
    state: { tone: "warning", text: de ? "Update nötig" : "Update required" },
    testId: "desktop-login-versions",
  });
  return page(
    opts.look,
    `<div class="stack" role="alert" data-testid="desktop-login-outdated">${pageHead({
      title: de ? "SubKit Desktop ist zu alt" : "SubKit Desktop is out of date",
      slot: "auth-heading",
      line: de
        ? "Aktualisiere die App und melde dich dann erneut an."
        : "Update the app, then sign in again.",
    })}${graphic}</div>${pageActions(browserLink(opts.look.locale))}${techDetails(
      opts.look.locale,
      [
        ["Code", "desktop_app_outdated"],
        ["HTTP", "426"],
      ],
    )}`,
  );
}

export function renderDesktopLoginExpired(look: PageLook): string {
  const de = look.locale === "de";
  return page(
    look,
    `<div class="stack" role="alert" data-testid="desktop-login-expired"><span class="dl-hero" aria-hidden="true">${icon("clock")}</span>${pageHead(
      {
        title: de ? "Anmeldung abgelaufen" : "Sign-in expired",
        slot: "auth-heading",
        line: de
          ? "Starte die Anmeldung in SubKit Desktop neu. Geändert wurde nichts."
          : "Start the sign-in again in SubKit Desktop. Nothing was changed.",
      },
    )}</div>${pageActions(browserLink(look.locale))}${techDetails(look.locale, [
      ["Code", "state_expired"],
      ["HTTP", "400"],
    ])}`,
  );
}
