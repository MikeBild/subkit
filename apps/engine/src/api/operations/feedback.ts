import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  ANONYMOUS_FEEDBACK_PATH,
  base64Ceiling,
  createFeedbackRateLimiter,
  existingReport,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_RECENT_ERRORS,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_MESSAGE_MAX,
  type FeedbackRateLimiter,
  FeedbackRefusedError,
  type SubmittedFeedback,
  submitFeedback,
} from "../../feedback/index.ts";
import { requireSignedInPerson } from "../../http/middleware/auth.ts";
import { now } from "../../utils/clock.ts";
import { ErrorSchema } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

export const FEEDBACK_PATH = "/v1/feedback";
export const FEEDBACK_TAGS = ["feedback"] as const;

const DiagnosticText = z.string().trim().min(1).max(200);

export const FeedbackDiagnosticsSchema = z
  .object({
    app_version: DiagnosticText.optional(),
    platform: DiagnosticText.optional(),
    client_kind: z.enum(["browser", "desktop", "pwa"]).optional(),
    server_version: DiagnosticText.optional(),
    connection: DiagnosticText.optional().describe("Connection state the client saw."),
    route: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe("Route the report was sent from."),
    recent_errors: z
      .array(
        z.object({
          code: z.string().trim().min(1).max(300),
          at: z.string().datetime(),
        }),
      )
      .max(FEEDBACK_MAX_RECENT_ERRORS)
      .optional(),
  })
  .openapi("FeedbackDiagnostics");

export const SubmitFeedbackSchema = z
  .object({
    client_request_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Send the same id again to retry a report without filing it twice. A retry of a report that was already filed is answered from the stored report and never counts against the rate limit.",
      ),
    created_on_device_at: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        "When the person wrote the report on their device, for a report sent later from an offline queue. Kept as the capture time when it lies within the last 30 days; otherwise the server time counts.",
      ),
    kind: z.enum(FEEDBACK_KINDS),
    message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX),
    diagnostics: FeedbackDiagnosticsSchema.optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().trim().min(1).max(255),
          content_base64: z
            .string()
            .min(1)
            .max(base64Ceiling(FEEDBACK_MAX_ATTACHMENT_BYTES))
            .describe("PNG, JPG, PDF, TXT or JSON, at most 2 MB."),
        }),
      )
      .max(FEEDBACK_MAX_ATTACHMENTS)
      .optional(),
    screenshot_png_base64: z
      .string()
      .min(1)
      .max(base64Ceiling(FEEDBACK_MAX_SCREENSHOT_BYTES))
      .optional()
      .describe("A PNG of the application window, at most 4 MB."),
  })
  .openapi("SubmitFeedbackBody");

export const AnonymousFeedbackSchema = SubmitFeedbackSchema.extend({
  contact_email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .describe("An address the operator may answer to. It is stored as written."),
  device_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "The device id of SubKit Desktop. The app sends it so its reports count against the device as well as the address.",
    ),
}).openapi("AnonymousFeedbackBody");

export type AnonymousFeedbackInput = z.infer<typeof AnonymousFeedbackSchema>;

export const SubmittedFeedbackSchema = z
  .object({
    id: z.string().uuid(),
    intake_item_id: z.string().uuid(),
    replayed: z.boolean().describe("true when this id was filed before and nothing new was filed."),
  })
  .openapi("SubmittedFeedback");

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

export const ANONYMOUS_FEEDBACK_SUMMARY = "Send a bug report or feedback without signing in";

export const ANONYMOUS_FEEDBACK_DESCRIPTION =
  "For the sign-in page and SubKit Desktop before sign-in. The report is cleaned the same way as a signed-in report and filed in the intake of the operator workspace under the category `feedback`, marked as `anonymous`. Each address may send 3 reports in 10 minutes, each desktop device (`device_id`) 3 as well, and the whole server 60. The whole request may hold at most 6 MB; the limits for each file stay the same.";

export const ANONYMOUS_FEEDBACK_RESPONSES = {
  201: {
    description: "Filed",
    content: { "application/json": { schema: SubmittedFeedbackSchema } },
  },
  403: errorResponse("Sent from another site"),
  409: errorResponse("Report id already used"),
  413: errorResponse("Request or attachment too large"),
  422: errorResponse("Attachment refused"),
  429: errorResponse("Too many reports"),
  503: errorResponse("This server takes no reports without signing in"),
} as const;

type SubmitFeedbackInput = z.infer<typeof SubmitFeedbackSchema>;

let limiter: FeedbackRateLimiter = createFeedbackRateLimiter();

export function resetFeedbackRateLimiter(next: FeedbackRateLimiter = createFeedbackRateLimiter()) {
  limiter = next;
}

export interface FeedbackRefusalResponse {
  readonly status: 409 | 413 | 422 | 503;
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export function feedbackRefusal(error: FeedbackRefusedError): FeedbackRefusalResponse {
  const details = { reason: error.reason, ...(error.filename ? { filename: error.filename } : {}) };
  if (error.reason === "attachment_too_large" || error.reason === "screenshot_too_large")
    return {
      status: 413,
      code: "payload_too_large",
      message: "an attached file is too large",
      details,
    };
  if (error.reason === "report_id_taken")
    return { status: 409, code: "conflict", message: "this report id was already used", details };
  if (error.reason === "intake_unavailable")
    return {
      status: 503,
      code: "feedback_unavailable",
      message: "this server takes no reports without signing in",
      details,
    };
  return {
    status: 422,
    code: "unprocessable",
    message: "an attached file cannot be accepted",
    details,
  };
}

function refusal(error: FeedbackRefusedError): Rejection {
  const response = feedbackRefusal(error);
  return reject.status(response.status, response.code, response.message, response.details);
}

export const submitFeedbackOperation = defineOperation<SubmitFeedbackInput, SubmittedFeedback>({
  id: "feedback.submit",
  summary: "Send a bug report, an idea or other feedback to this workspace's intake",
  permission: null,
  effect: "write",
  audit: AuditAction.FEEDBACK_SUBMITTED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    requireSignedInPerson(principal, "a signed-in person is required to send feedback");
    const actor = actorOf(principal);
    if (body.client_request_id) {
      try {
        const replay = await existingReport(scope.db, {
          tenant_id: scope.tenant_id,
          actor,
          report_id: body.client_request_id,
        });
        if (replay) return replay;
      } catch (error) {
        if (error instanceof FeedbackRefusedError) return refusal(error);
        throw error;
      }
    }
    const limit = await limiter.take(scope.db, `${scope.tenant_id}:${principal.id}`);
    if (!limit.allowed)
      return reject.status(429, "rate_limit_exceeded", "too many feedback reports", {
        retry_after_seconds: limit.retry_after_seconds,
      });
    try {
      return await submitFeedback(scope.db, {
        tenant_id: scope.tenant_id,
        actor,
        report_id: body.client_request_id ?? randomUUID(),
        kind: body.kind,
        message: body.message,
        diagnostics: body.diagnostics,
        attachments: body.attachments,
        screenshot_png_base64: body.screenshot_png_base64,
        now: new Date(now()),
        created_on_device_at: body.created_on_device_at
          ? new Date(body.created_on_device_at)
          : undefined,
      });
    } catch (error) {
      if (error instanceof FeedbackRefusedError) return refusal(error);
      throw error;
    }
  },
  http: {
    method: "post",
    path: FEEDBACK_PATH,
    tags: FEEDBACK_TAGS,
    description:
      "The report is cleaned of secrets, tokens, authorization headers, query strings, absolute file paths and, inside the diagnostics, email addresses. It is then filed in the intake of this workspace under the category `feedback`. Nothing is sent anywhere else.",
    body: SubmitFeedbackSchema,
    response: SubmittedFeedbackSchema,
    success: { status: 201, description: "Filed" },
    errors: {
      403: "A signed-in person is required",
      409: "Report id already used",
      413: "Attachment too large",
      422: "Attachment refused",
      429: "Too many reports",
    },
    toInput: ({ json }) => json as SubmitFeedbackInput,
    toBody: (result) => result,
  },
});
