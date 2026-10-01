import { z } from "@hono/zod-openapi";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import type { RequestStep } from "./types.ts";

const mailbox = z
  .string()
  .regex(
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/,
  );
export const ReportDeliveryBoundarySchema = z
  .object({
    kind: z.literal("gmail_report"),
    to: mailbox,
    from: mailbox,
    content_type: z.enum(["text/plain", "text/html", "multipart/alternative"]),
  })
  .strict();
export type ReportDeliveryBoundary = z.infer<typeof ReportDeliveryBoundarySchema>;
export const GMAIL_SEND_TARGET = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** Why a materialized message is outside the report profile. Recorded on the
 * held step and carried on a dispatch refusal, so a refused report says which
 * rule it broke instead of only that it broke one. */
export const REPORT_MESSAGE_REFUSALS = [
  "not_json_raw",
  "not_base64url",
  "not_utf8",
  "header_control_byte",
  "header_folded",
  "header_not_allowed",
  "header_duplicate",
  "missing_headers",
  "sender_invalid",
  "recipient_invalid",
  "extra_recipients",
  "multipart_unsupported",
  "content_type_unsupported",
  "transfer_encoding_unsupported",
  "body_not_base64",
] as const;
export type ReportMessageRefusal = (typeof REPORT_MESSAGE_REFUSALS)[number];

/** A message inside the profile that still is not the one that was reviewed. */
export type ReportDeliveryDiscrepancy =
  | "recipient_differs"
  | "sender_differs"
  | "content_type_differs";

/** Why a report dispatch was refused: the message is outside the profile, or
 * inside it and addressed differently from its reviewed boundary. */
export type ReportDeliveryRefusal = ReportMessageRefusal | ReportDeliveryDiscrepancy;

export type ReportMessageInspection =
  | { ok: true; boundary: ReportDeliveryBoundary; subject: string; text: string }
  | { ok: false; reason: ReportMessageRefusal };

/** What a held step records about its message: the verdict, never contents. */
export type ReportDeliveryInspectionRecord =
  | { ok: true }
  | { ok: false; reason: ReportMessageRefusal };

/** Narrow MIME profile, shared by proposal and dispatch. Unsupported MIME is
 * not guessed: additional recipients, folded/duplicate headers, attachments,
 * forwarding headers and encoded addresses all require concrete-run review. */
export function inspectReportMessage(body: unknown): ReportMessageInspection {
  const refuse = (reason: ReportMessageRefusal) => ({ ok: false, reason }) as const;
  try {
    const value = typeof body === "string" ? JSON.parse(body) : body;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.raw !== "string" ||
      value.raw.length > 1_000_000
    )
      return refuse("not_json_raw");
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value.raw)) return refuse("not_base64url");
    const bytes = Buffer.from(value.raw, "base64url");
    if (bytes.toString("base64url") !== value.raw.replace(/=+$/, ""))
      return refuse("not_base64url");
    let message: string;
    try {
      message = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return refuse("not_utf8");
    }
    const end = message.indexOf("\r\n\r\n");
    if (end < 0 || end > 16_384) return refuse("missing_headers");
    const headers = new Map<string, string>();
    for (const line of message.slice(0, end).split("\r\n")) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject ambiguous MIME control bytes
      const match = /^([A-Za-z-]+):[ \t]*([^\r\n\x00-\x1f\x7f]*)$/.exec(line);
      if (!match) return refuse("header_not_allowed");
      const key = match[1]!.toLowerCase();
      if (headers.has(key)) return refuse("header_duplicate");
      if (
        ![
          "from",
          "to",
          "subject",
          "mime-version",
          "content-type",
          "content-transfer-encoding",
        ].includes(key)
      )
        return refuse("header_not_allowed");
      headers.set(key, match[2]!.trim());
    }
    if (headers.get("mime-version") !== "1.0" || !headers.has("subject"))
      return refuse("missing_headers");
    const content = /^(text\/(?:plain|html))(?:;\s*charset="?utf-8"?)?$/i.exec(
      headers.get("content-type") ?? "",
    );
    if (!content) return refuse("content_type_unsupported");
    if (
      headers.has("content-transfer-encoding") &&
      !["7bit", "8bit", "base64"].includes(headers.get("content-transfer-encoding")!)
    )
      return refuse("transfer_encoding_unsupported");
    if (!mailbox.safeParse(headers.get("from")).success) return refuse("sender_invalid");
    if (!mailbox.safeParse(headers.get("to")).success) return refuse("recipient_invalid");
    const boundary: ReportDeliveryBoundary = {
      kind: "gmail_report",
      to: headers.get("to")!,
      from: headers.get("from")!,
      content_type: content[1]!.toLowerCase() as "text/plain" | "text/html",
    };
    let text = message.slice(end + 4);
    if (headers.get("content-transfer-encoding") === "base64") {
      // Decode only the single text body. Envelope headers remain exact and
      // multipart messages/attachments remain outside this report profile.
      const encoded = text.replace(/\r\n/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        return refuse("body_not_base64");
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.toString("base64") !== encoded) return refuse("body_not_base64");
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
      } catch {
        return refuse("not_utf8");
      }
    }
    return { ok: true, boundary, subject: headers.get("subject")!, text };
  } catch {
    return refuse("not_json_raw");
  }
}

/** The one comparison between a reviewed boundary and an inspected message,
 * shared by the review and the dispatcher so the two cannot drift apart. */
export function reportDeliveryDiscrepancy(
  declared: ReportDeliveryBoundary,
  observed: ReportDeliveryBoundary,
): ReportDeliveryDiscrepancy | null {
  if (observed.to !== declared.to) return "recipient_differs";
  if (observed.from !== declared.from) return "sender_differs";
  if (observed.content_type !== declared.content_type) return "content_type_differs";
  return null;
}

/** The recorded verdict for an inspection: never the message itself. */
export function reportInspectionRecord(
  inspection: ReportMessageInspection,
): ReportDeliveryInspectionRecord {
  return inspection.ok ? { ok: true } : { ok: false, reason: inspection.reason };
}

export function hasRuntimeValue(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some(hasRuntimeValue);
  return value !== null && typeof value === "object" && Object.values(value).some(hasRuntimeValue);
}

/** Only the body may vary. The endpoint, method and other authored options are
 * still exact-version bound. A reviewed recipient is never inferred at dispatch. */
export function supportsReportDelivery(step: RequestStep, target: string | null): boolean {
  const { body, ...fixed } = step;
  return (
    target === GMAIL_SEND_TARGET &&
    step.method === "POST" &&
    !step.pagination &&
    !step.xml &&
    !step.multipart &&
    !hasRuntimeValue(fixed) &&
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    "raw" in body
  );
}

export function supportsReadQuery(step: RequestStep): boolean {
  const { query, ...fixed } = step;
  return (
    step.method === "GET" &&
    !step.body &&
    !step.pagination &&
    !step.xml &&
    !step.multipart &&
    !hasRuntimeValue(fixed) &&
    query !== undefined &&
    hasRuntimeValue(query)
  );
}

/** Why a materialized request is not the reviewed report delivery, or null
 * when it is. `undefined` reason: the request is not a report send at all. */
function reportDeliveryRefusal(
  boundary: ReportDeliveryBoundary,
  request: MaterializedRequest | undefined,
): { reason?: ReportDeliveryRefusal } | null {
  const url = request ? new URL(request.url) : null;
  if (request?.method !== "POST" || !url || url.href !== GMAIL_SEND_TARGET) return {};
  if (request.unsupported_body) return {};
  const message = inspectReportMessage(request.body);
  if (!message.ok) return { reason: message.reason };
  const discrepancy = reportDeliveryDiscrepancy(boundary, message.boundary);
  return discrepancy ? { reason: discrepancy } : null;
}

export function assertReportDelivery(
  boundary: ReportDeliveryBoundary,
  request: MaterializedRequest | undefined,
): void {
  const refusal = reportDeliveryRefusal(boundary, request);
  if (refusal)
    throw Object.assign(
      new Error("Report delivery differs from the reviewed sender, recipient or message format"),
      { code: "execution_authority_changed", ...refusal },
    );
}

export const ReadQueryBoundarySchema = z
  .object({
    fixed: z.record(z.string(), z.string()),
    variable: z.array(z.string()).max(100),
  })
  .strict();
export function readQueryBoundary(step: RequestStep) {
  const url = new URL(step.path ?? step.url ?? "/", "https://boundary.invalid");
  const fixed = Object.fromEntries(url.searchParams);
  const variable: string[] = [];
  for (const [key, value] of Object.entries(step.query ?? {})) {
    if (hasRuntimeValue(value)) {
      variable.push(key);
      delete fixed[key];
    } else fixed[key] = String(value);
  }
  return { fixed, variable: variable.sort() };
}
export function assertReadQuery(
  boundary: z.infer<typeof ReadQueryBoundarySchema>,
  target: string | null,
  request: MaterializedRequest | undefined,
) {
  const deny = () => {
    throw Object.assign(new Error("Read request differs from its reviewed query boundary"), {
      code: "execution_authority_changed",
    });
  };
  if (request?.method !== "GET" || request.unsupported_body || request.body != null) return deny();
  const url = new URL(request.url);
  if (url.username || url.password || url.hash || `${url.origin}${url.pathname}` !== target)
    return deny();
  const keys = [...url.searchParams.keys()];
  const expected = [...Object.keys(boundary.fixed), ...boundary.variable];
  if (
    keys.length !== expected.length ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !expected.includes(key))
  )
    return deny();
  for (const [key, value] of Object.entries(boundary.fixed))
    if (url.searchParams.get(key) !== value) return deny();
}
