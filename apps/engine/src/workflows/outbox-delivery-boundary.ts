import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import {
  GMAIL_SEND_TARGET,
  inspectReportMessage,
  ReportDeliveryBoundarySchema,
  supportsReportDelivery,
} from "./report-delivery-boundary.ts";
import type { RequestStep, WorkflowDef } from "./types.ts";

const fieldPath = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/)
  .refine(
    (value) =>
      !value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)),
  );

export const OutboxDeliveryBoundarySchema = z
  .object({
    kind: z.literal("gmail_outbox"),
    source_step_id: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Earlier GET request step of this workflow that reads exactly one queued message from a fixed, approved address; the recipient is only ever taken from its response in the same run",
      ),
    recipient_field: fieldPath.describe(
      "Dot path inside the source step's response data that holds the one recipient address, for example email or item.email",
    ),
    item_id_field: fieldPath.describe(
      "Dot path inside the source step's response data that identifies the queued message; one dispatch attempt per workflow and item",
    ),
    from: ReportDeliveryBoundarySchema.shape.from,
    content_type: z.literal("text/plain"),
    max_body_bytes: z
      .number()
      .int()
      .min(1)
      .max(16384)
      .describe("Maximum UTF-8 serialized Gmail JSON request bytes"),
    max_per_day: z
      .number()
      .int()
      .min(1)
      .max(500)
      .describe("Most messages this workflow may send within any 24 hours"),
  })
  .strict();

export type OutboxDeliveryBoundary = z.infer<typeof OutboxDeliveryBoundarySchema>;

export function supportsOutboxDelivery(step: RequestStep, target: string | null): boolean {
  return (
    Boolean(step.outbox_delivery) &&
    !step.transactional_delivery &&
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

export function outboxSourceStep(
  definition: Pick<WorkflowDef, "steps">,
  step: RequestStep,
): RequestStep | null {
  const boundary = step.outbox_delivery;
  if (!boundary) return null;
  const sendIndex = definition.steps.findIndex((candidate) => candidate.id === step.id);
  const sourceIndex = definition.steps.findIndex(
    (candidate) => candidate.id === boundary.source_step_id,
  );
  const source = definition.steps[sourceIndex];
  if (
    sourceIndex < 0 ||
    sendIndex < 0 ||
    sourceIndex >= sendIndex ||
    source?.kind !== "request" ||
    (source.method ?? "GET") !== "GET" ||
    source.side_effects === "write" ||
    source.for_each ||
    source.data_selector ||
    source.response_filters?.length
  )
    return null;
  return source;
}

function field(value: unknown, path: string): unknown {
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

export interface OutboxSourceFacts {
  ok: boolean;
  recipient: unknown;
  item_id: unknown;
}

export function outboxSourceFacts(
  boundary: OutboxDeliveryBoundary,
  envelope: unknown,
): OutboxSourceFacts {
  const env =
    envelope && typeof envelope === "object" ? (envelope as Record<string, unknown>) : null;
  const status = env?.status_code;
  const ok =
    env !== null &&
    env.error === null &&
    env.held !== true &&
    typeof status === "number" &&
    status >= 200 &&
    status < 300;
  return {
    ok,
    recipient: ok ? field(env.data, boundary.recipient_field) : undefined,
    item_id: ok ? field(env.data, boundary.item_id_field) : undefined,
  };
}

export function outboxReceiptId(workflowId: string, sourceStepId: string, itemId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["outbox", workflowId, sourceStepId, itemId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assertOutboxMessage(
  boundary: OutboxDeliveryBoundary,
  workflowId: string,
  source: OutboxSourceFacts | undefined,
  request: MaterializedRequest | undefined,
) {
  const recipient = ReportDeliveryBoundarySchema.shape.to.max(255).safeParse(source?.recipient);
  const itemId =
    typeof source?.item_id === "number" && Number.isSafeInteger(source.item_id)
      ? String(source.item_id)
      : source?.item_id;
  const item = z.string().min(1).max(256).safeParse(itemId);
  const message = request ? inspectReportMessage(request.body) : null;
  if (
    !source?.ok ||
    !recipient.success ||
    !item.success ||
    !request ||
    request.method !== "POST" ||
    request.url !== GMAIL_SEND_TARGET ||
    request.unsupported_body ||
    !message?.ok ||
    message.boundary.to !== recipient.data ||
    message.boundary.from !== boundary.from ||
    message.boundary.content_type !== boundary.content_type ||
    Buffer.byteLength(JSON.stringify(request.body), "utf8") > boundary.max_body_bytes
  )
    throw Object.assign(
      new Error("Outbox email differs from the queued message and reviewed profile"),
      { code: "execution_authority_changed", reason: "outbox_delivery_differs" },
    );
  return {
    request_id: outboxReceiptId(workflowId, boundary.source_step_id, item.data),
    email: recipient.data,
  };
}
