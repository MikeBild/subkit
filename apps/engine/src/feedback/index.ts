export {
  ANONYMOUS_FEEDBACK_INSTANCE_LIMIT,
  ANONYMOUS_FEEDBACK_MAX_BODY_BYTES,
  ANONYMOUS_FEEDBACK_PATH,
  ANONYMOUS_FEEDBACK_SOURCE_LIMIT,
} from "./core/anonymous.ts";
export type {
  FormFieldError,
  FormFile,
  FormLocale,
  FormOutcome,
  FormValues,
  ParsedForm,
} from "./core/anonymous-form.ts";
export {
  ANONYMOUS_FEEDBACK_FORM_PATH,
  FORM_COPY,
  FORM_IMAGE_TYPES,
  formOutcome,
  parseAnonymousFeedbackForm,
} from "./core/anonymous-form.ts";
export {
  base64Ceiling,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
} from "./core/attachments.ts";
export { FEEDBACK_KINDS, FEEDBACK_MAX_RECENT_ERRORS, FEEDBACK_MESSAGE_MAX } from "./core/report.ts";
export type { AnonymousFeedbackRateLimiter, FeedbackRateLimiter } from "./rate-limit.ts";
export {
  ANONYMOUS_FEEDBACK_LIMITS,
  createAnonymousFeedbackRateLimiter,
  createFeedbackRateLimiter,
} from "./rate-limit.ts";
export type { SubmittedFeedback } from "./service.ts";
export {
  existingReport,
  FeedbackRefusedError,
  submitAnonymousFeedback,
  submitFeedback,
} from "./service.ts";
