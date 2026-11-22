import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ANONYMOUS_FEEDBACK_DESCRIPTION,
  ANONYMOUS_FEEDBACK_RESPONSES,
  ANONYMOUS_FEEDBACK_SUMMARY,
  AnonymousFeedbackSchema,
  FEEDBACK_TAGS,
  feedbackRefusal,
  submitFeedbackOperation,
} from "../../api/operations/feedback.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  ANONYMOUS_FEEDBACK_FORM_PATH,
  ANONYMOUS_FEEDBACK_MAX_BODY_BYTES,
  ANONYMOUS_FEEDBACK_PATH,
  type AnonymousFeedbackRateLimiter,
  createAnonymousFeedbackRateLimiter,
  FeedbackRefusedError,
  type FormFile,
  formOutcome,
  parseAnonymousFeedbackForm,
  submitAnonymousFeedback,
} from "../../feedback/index.ts";
import { now } from "../../utils/index.ts";
import { HttpError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";
import { renderFeedbackForm, renderFeedbackSent } from "./feedback-form-page.ts";
import { authHtmlResponse, resolvePageLook } from "./oauth/ui.ts";

let anonymousLimiter: AnonymousFeedbackRateLimiter = createAnonymousFeedbackRateLimiter();

export function resetAnonymousFeedbackRateLimiter(
  next: AnonymousFeedbackRateLimiter = createAnonymousFeedbackRateLimiter(),
): void {
  anonymousLimiter = next;
}

const anonymousFeedbackRoute = createRoute({
  method: "post",
  path: ANONYMOUS_FEEDBACK_PATH,
  tags: [...FEEDBACK_TAGS],
  summary: ANONYMOUS_FEEDBACK_SUMMARY,
  description: ANONYMOUS_FEEDBACK_DESCRIPTION,
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AnonymousFeedbackSchema } },
    },
  },
  responses: ANONYMOUS_FEEDBACK_RESPONSES,
});

type AnonymousSubmission = Omit<
  Parameters<typeof submitAnonymousFeedback>[1],
  "report_id" | "now"
> & { readonly report_id?: string | undefined; readonly device_id?: string | undefined };

async function fileAnonymous(c: Context<AppEnv>, submission: AnonymousSubmission) {
  if (c.req.header("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "csrf_rejected", "reports from another site are not accepted");
  const db = c.get("db");
  const { device_id, report_id, ...report } = submission;
  const limit = await anonymousLimiter.take(db, {
    ip: c.get("client_ip") ?? null,
    device_id: device_id ?? null,
  });
  if (!limit.allowed)
    throw new HttpError(429, "rate_limit_exceeded", "too many feedback reports", {
      retry_after: limit.retry_after_seconds,
    });
  try {
    return await submitAnonymousFeedback(db, {
      ...report,
      report_id: report_id ?? randomUUID(),
      now: new Date(now()),
    });
  } catch (error) {
    if (!(error instanceof FeedbackRefusedError)) throw error;
    const refusal = feedbackRefusal(error);
    throw new HttpError(refusal.status, refusal.code, refusal.message, {
      details: refusal.details,
    });
  }
}

async function formFile(raw: unknown): Promise<{ file: FormFile; bytes: Uint8Array } | null> {
  if (!(raw instanceof File) || raw.size === 0) return null;
  return {
    file: { name: raw.name, type: raw.type, size: raw.size },
    bytes: new Uint8Array(await raw.arrayBuffer()),
  };
}

function htmlPage(html: string, status: number): Response {
  return authHtmlResponse(html, status);
}

export function registerFeedbackRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, submitFeedbackOperation);
  app.use(
    ANONYMOUS_FEEDBACK_PATH,
    bodyLimit({
      maxSize: ANONYMOUS_FEEDBACK_MAX_BODY_BYTES,
      onError: () => {
        throw new HttpError(413, "payload_too_large", "the report is too large", {
          details: { max_bytes: ANONYMOUS_FEEDBACK_MAX_BODY_BYTES },
        });
      },
    }),
  );
  app.openapi(anonymousFeedbackRoute, async (c) => {
    const body = c.req.valid("json");
    const filed = await fileAnonymous(c, {
      report_id: body.client_request_id,
      device_id: body.device_id,
      kind: body.kind,
      message: body.message,
      diagnostics: body.diagnostics,
      attachments: body.attachments,
      screenshot_png_base64: body.screenshot_png_base64,
      contact_email: body.contact_email,
      created_on_device_at: body.created_on_device_at
        ? new Date(body.created_on_device_at)
        : undefined,
    });
    return c.json(filed, 201);
  });
  app.get(ANONYMOUS_FEEDBACK_FORM_PATH, (c) =>
    htmlPage(renderFeedbackForm(resolvePageLook(c.req.raw.headers)), 200),
  );
  app.use(
    ANONYMOUS_FEEDBACK_FORM_PATH,
    bodyLimit({
      maxSize: ANONYMOUS_FEEDBACK_MAX_BODY_BYTES,
      onError: (c) =>
        htmlPage(
          renderFeedbackForm(resolvePageLook(c.req.raw.headers), { outcome: "refused" }),
          413,
        ),
    }),
  );
  app.post(ANONYMOUS_FEEDBACK_FORM_PATH, async (c) => {
    const look = resolvePageLook(c.req.raw.headers);
    const fields = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const upload = await formFile(fields.screenshot);
    const parsed = parseAnonymousFeedbackForm({
      message: fields.message,
      email: fields.email,
      screenshot: upload?.file ?? null,
    });
    if (!parsed.ok)
      return htmlPage(
        renderFeedbackForm(look, { values: parsed.values, errors: parsed.errors }),
        400,
      );
    try {
      await fileAnonymous(c, {
        kind: "bug",
        message: parsed.message,
        diagnostics: { client_kind: "browser" },
        attachments: upload
          ? [
              {
                filename: upload.file.name || "screenshot",
                content_base64: Buffer.from(upload.bytes).toString("base64"),
              },
            ]
          : undefined,
        contact_email: parsed.contact_email ?? undefined,
      });
      return htmlPage(renderFeedbackSent(look), 201);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const outcome = formOutcome(error.status);
      return htmlPage(
        renderFeedbackForm(look, {
          values: { message: parsed.message, email: parsed.contact_email ?? "" },
          ...(outcome === "sent" ? {} : { outcome }),
        }),
        error.status,
      );
    }
  });
}
