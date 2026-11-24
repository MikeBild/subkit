import { scrubString } from "../../logging/index.ts";
import {
  APPROVAL_CLAIM_WINDOW_MS,
  APPROVAL_PORTAL_PATH,
  type ApprovalPortalView,
  type ApprovalSubject,
} from "../../tools/index.ts";
import { escapeHtml } from "./oauth/shared.ts";
import { cockpitLink, type PageLook, pageActions, pageHead, renderSinglePage } from "./oauth/ui.ts";
import { approvalCopy } from "./tool-approval-copy.ts";

function visible(value: string): string {
  return escapeHtml(scrubString(value));
}

export function approvalDisplayTarget(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "s3:", "postgres:", "postgresql:"].includes(url.protocol)) return null;
    const origin = ["s3:", "postgres:", "postgresql:"].includes(url.protocol)
      ? `${url.protocol}//${url.host}`
      : url.origin;
    return scrubString(`${origin}${url.pathname}`);
  } catch {
    return null;
  }
}

type ApprovalCopy = ReturnType<typeof approvalCopy>;

const subjectLabel = (subject: ApprovalSubject): string =>
  scrubString(subject.current_name ?? subject.current_slug ?? subject.resource_id);

const subjectFacts = (subject: ApprovalSubject, copy: ApprovalCopy) => {
  const changeLabels: Record<ApprovalSubject["changes"][number]["field"], string> = {
    name: copy.proposedName,
    slug: copy.proposedSlug,
    description: copy.proposedDescription,
    lifecycle: copy.proposedLifecycle,
  };
  const target =
    subject.current_name && subject.current_slug
      ? `${scrubString(subject.current_name)} (${scrubString(subject.current_slug)})`
      : subjectLabel(subject);
  return [
    [copy.workflow, target] as const,
    ...subject.changes.map(
      (change) =>
        [changeLabels[change.field], change.to ? scrubString(change.to) : copy.cleared] as const,
    ),
  ];
};

const subjectTitle = (subject: ApprovalSubject, copy: ApprovalCopy): string =>
  (subject.changes.some((change) => change.field === "name" || change.field === "slug")
    ? copy.titleForRename
    : copy.titleForWorkflowChange
  ).replace("{workflow}", subjectLabel(subject));

function portalPage(look: PageLook, body: string, opts: { wide?: boolean; footer?: string } = {}) {
  return renderSinglePage({
    look,
    surface: "auth",
    context: approvalCopy(look.locale).context,
    body,
    attributes: ' data-approval-product="subkit"',
    ...opts,
  });
}

export function approvalStatusPage(
  look: PageLook,
  title: string,
  message: string,
  status: 200 | 400 = 400,
): { html: string; status: 200 | 400 } {
  const copy = approvalCopy(look.locale);
  return {
    status,
    html: portalPage(
      look,
      `${pageHead({ title, slot: "auth-heading", line: message })}<p class="note" role="note"><span class="strong">${copy.outcome}.</span> ${copy.outcomeHelp}</p>${pageActions(cockpitLink(look.locale))}`,
    ),
  };
}

export function alreadyDecidedPage(view: ApprovalPortalView, look: PageLook) {
  const copy = approvalCopy(look.locale);
  if (view.state === "declined")
    return approvalStatusPage(look, copy.declinedTitle, copy.declinedMessage);
  if (view.state === "consumed")
    return approvalStatusPage(look, copy.consumedTitle, copy.consumedMessage, 200);
  return approvalStatusPage(look, copy.approvedTitle, copy.approvedMessage, 200);
}

export function buildApprovalDecisionHtml(
  view: ApprovalPortalView,
  grant: string,
  approver: { email: string; user_id?: string },
  csrfToken: string,
  look: PageLook,
  actionPath = APPROVAL_PORTAL_PATH,
): string {
  const locale = look.locale;
  const copy = approvalCopy(locale);
  const date = new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    dateStyle: "long",
    timeStyle: "long",
    timeZone: "UTC",
  }).format(view.expires_at);
  const executionMode = view.preview?.direct_connector?.target.environment ?? view.execution_mode;
  const environment =
    executionMode === "dev" ? copy.dev : executionMode === "prod" ? copy.prod : copy.unspecified;
  const binding = view.preview?.prepared_workflow;
  const requester = view.requester;
  const requesterLabel = requester
    ? `${requester.label ? `${requester.label} · ` : ""}${requester.kind === "user" ? copy.person : copy.systemAccount}${requester.kind === "user" && requester.id === approver.user_id ? ` · ${copy.ownRequest}` : ""}`
    : copy.unspecified;
  const facts = (rows: (readonly [string, string])[]) =>
    rows
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join("");
  const subject = view.preview?.subject;
  const subjectRows = subject ? subjectFacts(subject, copy) : [];
  const bindingFacts = facts([
    [copy.tool, scrubString(view.tool)],
    ...(view.workflow_slug ? [[copy.workflow, scrubString(view.workflow_slug)] as const] : []),
    ...subjectRows,
    ...(binding ? [[copy.version, binding.workflow_version_id] as const] : []),
    [copy.decider, approver.email],
    [copy.scope, copy.once],
    [copy.claim, copy.claimHelp.replace("{minutes}", String(APPROVAL_CLAIM_WINDOW_MS / 60_000))],
  ]);
  const reviews = binding?.request_reviews ?? [];
  const direct = view.preview?.direct_connector;
  const writes = [
    ...reviews,
    ...(direct ? [direct.review] : []),
    ...(view.preview?.would_write ?? []).filter(
      (write) => !direct && !reviews.some((review) => review.step === write.step),
    ),
  ];
  const boundRequests = direct ? [direct.review] : reviews;
  const firstBound = boundRequests[0];
  const boundTarget = firstBound ? approvalDisplayTarget(firstBound.url) : null;
  const title =
    boundRequests.length > 1
      ? copy.titleForRequests.replace("{count}", String(boundRequests.length))
      : firstBound && boundTarget
        ? copy.titleForTarget
            .replace("{operation}", scrubString(firstBound.method ?? copy.unspecified))
            .replace("{target}", boundTarget)
        : subject
          ? subjectTitle(subject, copy)
          : copy.title;
  const glance = facts([
    ...subjectRows,
    ...(firstBound && boundTarget && boundRequests.length === 1
      ? [
          [
            copy.targetShort,
            `${scrubString(firstBound.method ?? copy.unspecified)} ${boundTarget}`,
          ] as const,
        ]
      : []),
    [copy.environment, environment],
    [copy.requester, scrubString(requesterLabel)],
    [copy.expiry, date],
  ]);
  const effects = writes.length
    ? `<p class="muted">${direct ? copy.directEffectsHelp : copy.effectsHelp}</p><ul class="plain stack">${writes
        .map((write) => {
          const review = reviews.find((candidate) => candidate === write);
          return `<li class="stack"><dl class="facts">
<dt>${copy.step}</dt><dd class="mono">${visible(write.step)}</dd>
<dt>${copy.method}</dt><dd class="mono">${visible(write.method ?? copy.unspecified)}</dd>
<dt>${copy.target}</dt><dd class="mono">${escapeHtml(approvalDisplayTarget(write.url) ?? copy.unspecified)}</dd>
${review ? `<dt>${copy.attempts}</dt><dd>${escapeHtml(copy.attemptsValue.replace("{count}", String(review.max_attempts)))}</dd>` : ""}
</dl>${review ? `<section class="stack"><h3>${copy.requestContent}</h3><p class="muted">${copy.contentHelp}</p>${review.request_review_truncated ? `<p role="note">${copy.contentTruncated}</p>` : ""}${review.opaque_payload_omitted ? `<p role="note">${copy.opaqueContent}</p>` : ""}<pre class="payload">${visible(review.redacted_request_json)}</pre></section>` : binding ? `<p class="muted">${copy.missingReview}</p>` : ""}</li>`;
        })
        .join("")}</ul>`
    : `<p class="muted">${copy.missing}</p>`;
  const hidden = `<input type="hidden" name="grant" value="${escapeHtml(grant)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;
  const language = `<form method="POST" action="${escapeHtml(actionPath)}" aria-label="${copy.language}">${hidden}<button class="button ghost" type="submit" name="language" value="de" lang="de" aria-pressed="${locale === "de"}">Deutsch</button><button class="button ghost" type="submit" name="language" value="en" lang="en" aria-pressed="${locale === "en"}">English</button></form>`;
  return portalPage(
    look,
    `${pageHead({ title, slot: "auth-heading", line: copy.intro, chip: { tone: "warning", word: copy.pending } })}
<dl class="facts">${glance}</dl>${boundRequests.length === 0 && !subject ? `<p class="muted">${copy.unknownEffect}</p>` : ""}
<details><summary>${copy.details}</summary><div class="stack">
<p>${copy.contextNote}</p>
<section class="stack" aria-labelledby="boundary-title"><h2 id="boundary-title">${copy.summary}</h2><dl class="facts">${bindingFacts}</dl></section>
<section class="stack" aria-labelledby="effects-title"><h2 id="effects-title">${copy.effects}</h2>${effects}<p class="muted">${reviews.length > 0 ? copy.boundHelp : binding ? copy.versionOnlyHelp : view.preview?.direct_connector ? copy.directBoundHelp : copy.limitations}</p>${reviews.length > 0 ? `<p class="muted">${copy.attemptsHelp}</p>` : ""}</section>
<h2>${copy.why}</h2><p>${copy.whyHelp}</p><h2>${copy.changes}</h2><p>${copy.changesHelp}</p><p>${copy.via}: <span class="mono">${visible(view.surface)}</span></p>
<p class="note" role="note"><span class="strong">${copy.outcome}.</span> ${copy.outcomeHelp}</p>
<p>${copy.attribution}</p></div></details>
<p>${copy.signed} <strong>${escapeHtml(approver.email)}</strong>.</p>
<form method="POST" action="${escapeHtml(actionPath)}">${hidden}<input type="hidden" name="language" value="${locale}">${pageActions(`<button class="button outline" type="submit" name="decision" value="decline">${copy.decline}</button><button class="button primary" type="submit" name="decision" value="approve">${copy.approve}</button>`)}</form>`,
    { wide: true, footer: language },
  );
}
