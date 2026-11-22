import {
  ANONYMOUS_FEEDBACK_FORM_PATH,
  FORM_COPY,
  FORM_IMAGE_TYPES,
  type FormFieldError,
  type FormOutcome,
  type FormValues,
} from "../../feedback/index.ts";
import { escapeHtml } from "./oauth/shared.ts";
import { type PageLook, pageActions, pageHead, renderSinglePage } from "./oauth/ui.ts";

const SIGN_IN_PATH = "/v1/identity/login/start";
const FORM_STYLES =
  "textarea,input[type=email],input[type=file]{width:100%;padding:8px 12px;border:1px solid var(--input);border-radius:var(--radius-md);background:var(--background);color:var(--foreground);font:inherit}textarea{min-height:140px;resize:vertical}";

function backLink(look: PageLook): string {
  return `<a class="button outline" href="${SIGN_IN_PATH}" data-testid="feedback-form-back">${escapeHtml(FORM_COPY[look.locale].back)}</a>`;
}

export function feedbackFormLink(look: PageLook): string {
  return `<a class="link" href="${ANONYMOUS_FEEDBACK_FORM_PATH}" data-testid="auth-report-problem">${escapeHtml(FORM_COPY[look.locale].link)}</a>`;
}

export function renderFeedbackForm(
  look: PageLook,
  state: {
    values?: FormValues;
    errors?: readonly FormFieldError[];
    outcome?: Exclude<FormOutcome, "sent">;
  } = {},
): string {
  const copy = FORM_COPY[look.locale];
  const values = state.values ?? { message: "", email: "" };
  const problems = [
    ...(state.errors ?? []).map((error) => copy.errors[error]),
    ...(state.outcome ? [copy.outcomes[state.outcome].line] : []),
  ];
  const alert =
    problems.length > 0
      ? `<div class="error" role="alert" data-testid="feedback-form-error">${problems.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>`
      : "";
  return renderSinglePage({
    look,
    surface: "auth",
    context: copy.title,
    styles: FORM_STYLES,
    body: `${pageHead({ title: copy.title, slot: "auth-heading", line: copy.lead })}<form method="POST" action="${ANONYMOUS_FEEDBACK_FORM_PATH}" enctype="multipart/form-data" data-testid="feedback-form"><label class="field">${escapeHtml(copy.message)}<textarea name="message" required maxlength="5000">${escapeHtml(values.message)}</textarea></label><label class="field">${escapeHtml(copy.email)}<input type="email" name="email" autocomplete="email" maxlength="254" value="${escapeHtml(values.email)}"></label><label class="field">${escapeHtml(copy.screenshot)}<input type="file" name="screenshot" accept="${FORM_IMAGE_TYPES.join(",")}"></label><p class="muted">${escapeHtml(copy.note)}</p>${alert}${pageActions(`${backLink(look)}<button class="button primary" type="submit">${escapeHtml(copy.submit)}</button>`)}</form>`,
  });
}

export function renderFeedbackSent(look: PageLook): string {
  const copy = FORM_COPY[look.locale];
  const sent = copy.outcomes.sent;
  return renderSinglePage({
    look,
    surface: "auth",
    context: copy.title,
    body: `<div class="stack" data-testid="feedback-form-sent" role="status">${pageHead({ title: sent.title, slot: "auth-heading", line: sent.line })}</div>${pageActions(backLink(look))}`,
  });
}
