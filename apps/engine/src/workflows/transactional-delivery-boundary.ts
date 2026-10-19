import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import {
  GMAIL_SEND_TARGET,
  inspectReportMessage,
  ReportDeliveryBoundarySchema,
  supportsReportDelivery,
} from "./report-delivery-boundary.ts";
import type { RequestStep } from "./types.ts";

const inputPath = z
  .string()
  .max(128)
  .regex(/^body(?:\.[A-Za-z_][A-Za-z0-9_]*){1,7}$/)
  .refine(
    (value) =>
      !value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)),
  );

export const TransactionalDeliveryBoundarySchema = z
  .object({
    kind: z.literal("gmail_transactional"),
    webhook_verifier: z.enum(["standard", "hmac"]).optional(),
    webhook_id: z
      .string()
      .uuid()
      .describe(
        "Reviewed active Standard Webhooks or signed-body HMAC binding in the same tenant and workflow; unsigned ingress is forbidden",
      ),
    event_type: z
      .string()
      .min(1)
      .max(128)
      .describe("The single allowed event type configured on the signed binding"),
    event_type_input: inputPath.describe(
      "Reviewed event type field inside the signed body, equal to event_type; webhook-type alone is not signed",
    ),
    recipient_input: inputPath.describe(
      "Reviewed dot path in the original admitted input, for example body.applicant.email; never a step output or caller-supplied routing override",
    ),
    request_id_input: inputPath.describe(
      "Reviewed signed request identity equal to the normalized webhook ID: UUID for Standard Webhooks, bounded signed-body string for HMAC. One persistent dispatch attempt per workflow and identity; HMAC identities use an opaque deterministic receipt UUID.",
    ),
    from: ReportDeliveryBoundarySchema.shape.from,
    content_type: z.literal("text/plain"),
    max_body_bytes: z
      .number()
      .int()
      .min(1)
      .max(16384)
      .describe(
        "Maximum UTF-8 serialized Gmail JSON request bytes; derive from bounded template inputs",
      ),
  })
  .strict();

export type TransactionalDeliveryBoundary = z.infer<typeof TransactionalDeliveryBoundarySchema>;

export function supportsTransactionalDelivery(step: RequestStep, target: string | null): boolean {
  return (
    Boolean(step.transactional_delivery) &&
    !step.report_delivery &&
    !step.boundary &&
    !step.for_each &&
    !step.for_each_concurrency &&
    !step.data_selector &&
    !step.response_filters?.length &&
    step.max_retries === 0 &&
    step.side_effects !== "read" &&
    supportsReportDelivery(step, target)
  );
}

const eventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.string().min(1).max(128),
    body: z.record(z.string(), z.unknown()),
  })
  .passthrough();

function inputField(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object" && Object.hasOwn(current, key)
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

export function assertTransactionalMessage(
  boundary: TransactionalDeliveryBoundary,
  rawInput: unknown,
  request: MaterializedRequest | undefined,
) {
  const input = eventSchema.safeParse(rawInput);
  const recipient = ReportDeliveryBoundarySchema.shape.to
    .max(255)
    .safeParse(inputField(rawInput, boundary.recipient_input));
  const requestId =
    boundary.webhook_verifier === "hmac"
      ? z.string().min(1).max(256).safeParse(inputField(rawInput, boundary.request_id_input))
      : z.string().uuid().safeParse(inputField(rawInput, boundary.request_id_input));
  const message = request ? inspectReportMessage(request.body) : null;
  if (
    !input.success ||
    !recipient.success ||
    !requestId.success ||
    input.data.id !== requestId.data ||
    input.data.type !== boundary.event_type ||
    inputField(rawInput, boundary.event_type_input) !== boundary.event_type ||
    !request ||
    request.method !== "POST" ||
    request.url !== GMAIL_SEND_TARGET ||
    request.unsupported_body ||
    !message?.ok ||
    message.boundary.to !== recipient.data ||
    message.boundary.from !== boundary.from ||
    message.boundary.content_type !== boundary.content_type ||
    Buffer.byteLength(JSON.stringify(request.body), "utf8") > boundary.max_body_bytes
  ) {
    throw Object.assign(
      new Error("Transactional email differs from the signed request and reviewed profile"),
      {
        code: "execution_authority_changed",
        reason: "transactional_delivery_differs",
      },
    );
  }
  let receiptId = requestId.data;
  if (boundary.webhook_verifier === "hmac") {
    const bytes = createHash("sha256")
      .update(JSON.stringify(["transactional-hmac", requestId.data]))
      .digest()
      .subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    receiptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return { request_id: receiptId, email: recipient.data };
}
