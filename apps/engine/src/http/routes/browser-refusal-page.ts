import { REFUSAL_COPY, type RefusalKind } from "../i18n/browser-refusal.ts";
import { escapeHtml } from "./oauth/shared.ts";
import {
  type AuthLocale,
  cockpitLink,
  type PageLook,
  pageActions,
  pageHead,
  renderSinglePage,
} from "./oauth/ui.ts";

function refusalKind(code: string, status: number): RefusalKind {
  if (status === 429 || code === "rate_limit_exceeded") return "rate_limited";
  if (code === "invalid_redirect_uri") return "target_refused";
  if (code === "csrf_rejected" || code === "cross_origin_rejected") return "cross_site";
  return "other";
}

export function renderBrowserRefusalPage(opts: {
  look: PageLook;
  code: string;
  status: number;
  retryAfterSeconds: number | null;
  reloadHref: string | null;
}): string {
  const copy = REFUSAL_COPY[opts.look.locale];
  const kind = refusalKind(opts.code, opts.status);
  const text = copy[kind];
  const action =
    kind === "rate_limited" && opts.reloadHref
      ? `<a class="button primary" href="${escapeHtml(opts.reloadHref)}" data-testid="page-reload-link">${copy.reload}</a>`
      : cockpitLink(opts.look.locale);
  const facts = `<p class="muted mono" data-testid="page-refusal-code">${copy.code} ${escapeHtml(opts.code)} · HTTP ${opts.status}</p>`;
  return renderSinglePage({
    look: opts.look,
    surface: "auth",
    context: copy.context,
    body: `<div class="stack" role="alert" data-testid="browser-refusal" data-refusal-kind="${kind}">${pageHead(
      {
        title: text.title,
        slot: "auth-heading",
        line: text.line(opts.retryAfterSeconds),
      },
    )}</div>${pageActions(action, { slot: "failure-actions" })}${facts}`,
  });
}
