export {
  base64Ceiling,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
} from "./core/attachments.ts";
export { FEEDBACK_KINDS, FEEDBACK_MAX_RECENT_ERRORS, FEEDBACK_MESSAGE_MAX } from "./core/report.ts";
export type { FeedbackRateLimiter } from "./rate-limit.ts";
export { createFeedbackRateLimiter } from "./rate-limit.ts";
export type { SubmittedFeedback } from "./service.ts";
export { existingReport, FeedbackRefusedError, submitFeedback } from "./service.ts";
