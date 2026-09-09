import { escapeHtml } from "../../connectors/index.ts";
import { scrubString } from "../../logging/index.ts";
import {
  APPROVAL_CLAIM_WINDOW_MS,
  APPROVAL_PORTAL_PATH,
  type ApprovalPortalView,
} from "../../tools/index.ts";
import { AUTH_UI_DIGEST, AUTH_UI_STYLES, type AuthLocale } from "./oauth/ui.ts";
import { approvalCopy } from "./tool-approval-copy.ts";

const STYLES = `
body{align-items:flex-start}.approval-card{max-width:960px;margin:24px auto;padding:32px;overflow-wrap:anywhere}
.approval-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.approval-status{background:var(--muted);color:var(--foreground);border-radius:var(--radius-md);padding:8px 12px;font-size:.85rem}
.approval-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:24px 0}
.approval-grid>div,.approval-effect{border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;min-width:0}
dt{color:var(--muted-foreground);font-size:.85rem;margin-bottom:6px}dd{margin:0;line-height:1.5}h2{font-size:1rem;margin:0 0 12px}
.approval-effects{list-style:none;padding:0;margin:16px 0;display:grid;gap:12px}.approval-effect dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;margin:0}
.approval-note{background:var(--muted);padding:16px;border-radius:var(--radius-md);margin:20px 0}.approval-note p:last-child{margin-bottom:0}
.approval-details{border:1px solid var(--border);border-radius:var(--radius-lg);margin:24px 0}.approval-details summary{cursor:pointer;padding:14px 16px;min-height:44px}.approval-details>div{padding:16px;border-top:1px solid var(--border)}
.approval-language{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.approval-language button{flex:none;font-size:.85rem;padding:8px 12px;background:var(--card);color:var(--foreground);border-color:var(--border)}.approval-language button[aria-pressed=true]{background:var(--muted)}
.approval-actions{border-top:1px solid var(--border);padding-top:20px}.mono{font-family:ui-monospace,monospace}.approval-footer{margin-top:24px;font-size:.8rem;color:var(--muted-foreground)}
@media(max-width:600px){.approval-card{margin:8px auto;padding:20px}.approval-grid{grid-template-columns:1fr}.approval-effect dl{grid-template-columns:1fr;gap:4px}.approval-effect dd{margin-bottom:8px}}
`;

function visible(value: string): string {
  return escapeHtml(scrubString(value));
}

/** No credential-bearing URL component is needed to identify a display target. */
export function approvalDisplayTarget(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "s3:"].includes(url.protocol)) return null;
    const origin = url.protocol === "s3:" ? `s3://${url.host}` : url.origin;
    return scrubString(`${origin}${url.pathname}`);
  } catch {
    return null;
  }
}

function shell(locale: AuthLocale, title: string, body: string): string {
  return `<!doctype html><html lang="${locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<meta name="mcp-auth-ui-contract" content="${AUTH_UI_DIGEST}">
<title>${escapeHtml(title)} — SubKit</title><style>${AUTH_UI_STYLES}${STYLES}</style>
</head><body><main class="card approval-card" data-approval-product="subkit">
${body}<footer class="approval-footer">SubKit · ${approvalCopy(locale).context}</footer>
</main></body></html>`;
}

export function approvalStatusPage(
  locale: AuthLocale,
  title: string,
  message: string,
  status: 200 | 400 = 400,
): { html: string; status: 200 | 400 } {
  const copy = approvalCopy(locale);
  return {
    status,
    html: shell(
      locale,
      title,
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<section class="approval-note" aria-labelledby="outcome-title"><h2 id="outcome-title">${copy.outcome}</h2><p class="muted">${copy.outcomeHelp}</p></section>`,
    ),
  };
}

export function alreadyDecidedPage(view: ApprovalPortalView, locale: AuthLocale) {
  const copy = approvalCopy(locale);
  if (view.state === "declined")
    return approvalStatusPage(locale, copy.declinedTitle, copy.declinedMessage);
  if (view.state === "consumed")
    return approvalStatusPage(locale, copy.consumedTitle, copy.consumedMessage, 200);
  return approvalStatusPage(locale, copy.approvedTitle, copy.approvedMessage, 200);
}

export function buildApprovalDecisionHtml(
  view: ApprovalPortalView,
  grant: string,
  approver: { email: string },
  csrfToken: string,
  locale: AuthLocale,
): string {
  const copy = approvalCopy(locale);
  const date = new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    dateStyle: "long",
    timeStyle: "long",
    timeZone: "UTC",
  }).format(view.expires_at);
  const environment =
    view.execution_mode === "dev"
      ? copy.dev
      : view.execution_mode === "prod"
        ? copy.prod
        : copy.unspecified;
  const summary = [
    [copy.tool, scrubString(view.tool)],
    ...(view.workflow_slug ? [[copy.workflow, scrubString(view.workflow_slug)]] : []),
    [copy.environment, environment],
    [copy.scope, copy.once],
    [copy.expiry, date],
    [copy.claim, copy.claimHelp.replace("{minutes}", String(APPROVAL_CLAIM_WINDOW_MS / 60_000))],
  ]
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label ?? "")}</dt><dd>${escapeHtml(value ?? "")}</dd></div>`,
    )
    .join("");
  const writes = view.preview?.would_write ?? [];
  const effects = writes.length
    ? `<p class="muted">${copy.effectsHelp}</p><ul class="approval-effects">${writes
        .map(
          (write) => `<li class="approval-effect"><dl>
<dt>${copy.step}</dt><dd class="mono">${visible(write.step)}</dd>
<dt>${copy.method}</dt><dd class="mono">${visible(write.method ?? copy.unspecified)}</dd>
<dt>${copy.target}</dt><dd class="mono">${escapeHtml(approvalDisplayTarget(write.url) ?? copy.unspecified)}</dd>
</dl></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">${copy.missing}</p>`;
  // POSTing a language choice is a read-only render action. Keep the grant out
  // of visible links, avoid JavaScript, and never attach a decision to it.
  const hidden = `<input type="hidden" name="grant" value="${escapeHtml(grant)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;
  const language = `<form class="approval-language" method="POST" action="${APPROVAL_PORTAL_PATH}" aria-label="${copy.language}">${hidden}
<button type="submit" name="language" value="de" lang="de" aria-pressed="${locale === "de"}">Deutsch</button>
<button type="submit" name="language" value="en" lang="en" aria-pressed="${locale === "en"}">English</button></form>`;
  return shell(
    locale,
    copy.title,
    `<header class="approval-header"><strong>SubKit · ${copy.context}</strong>${language}<span class="approval-status">${copy.pending}</span></header>
<h1>${copy.title}</h1><p class="muted">${copy.intro}</p>
<section aria-labelledby="boundary-title"><h2 id="boundary-title">${copy.summary}</h2><dl class="approval-grid">${summary}</dl></section>
<section aria-labelledby="effects-title"><h2 id="effects-title">${copy.effects}</h2>${effects}<p class="muted">${copy.limitations}</p></section>
<details class="approval-details"><summary>${copy.details}</summary><div>
<h2>${copy.why}</h2><p>${copy.whyHelp}</p><h2>${copy.changes}</h2><p>${copy.changesHelp}</p><p>${copy.via}: <span class="mono">${visible(view.surface)}</span></p></div></details>
<section class="approval-note" aria-labelledby="outcome-title"><h2 id="outcome-title">${copy.outcome}</h2><p class="muted">${copy.outcomeHelp}</p></section>
<p>${copy.signed} <strong>${escapeHtml(approver.email)}</strong>. ${copy.attribution}</p>
<form method="POST" action="${APPROVAL_PORTAL_PATH}" class="approval-actions">${hidden}<input type="hidden" name="language" value="${locale}"><div class="actions">
<button class="deny" type="submit" name="decision" value="decline">${copy.decline}</button>
<button class="approve" type="submit" name="decision" value="approve">${copy.approve}</button>
</div></form>`,
  );
}
