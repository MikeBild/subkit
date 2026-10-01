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

type Refused = { ok: false; reason: ReportMessageRefusal };
const refuse = (reason: ReportMessageRefusal): Refused => ({ ok: false, reason });

const ENVELOPE_HEADERS = new Set([
  "from",
  "to",
  "subject",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);
const PART_HEADERS = new Set(["content-type", "content-transfer-encoding"]);
const TRANSFER_ENCODINGS = new Set(["7bit", "8bit", "base64"]);
const TEXT_TYPE = /^(text\/(?:plain|html))(?:;\s*charset="?utf-8"?)?$/i;
const ALTERNATIVE_TYPE = /^multipart\/alternative;\s*boundary=(?:"([^"]*)"|([^\s";]+))$/i;
// RFC 2046 boundary characters, without the space it permits mid-boundary.
const BOUNDARY = /^[0-9A-Za-z'()+_,./:=?-]{1,70}$/;
// One whole RFC 2047 B-encoded UTF-8 word: the unit sk.buildMimeMessage folds.
const ENCODED_WORD = /^=\?utf-8\?b\?([A-Za-z0-9+/]+={0,2})\?=$/i;
// Every control byte except the tab RFC 5322 allows inside a field body.
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject ambiguous MIME control bytes
const CONTROL_BYTE = /[\x00-\x08\x0a-\x1f\x7f]/;
const FIELD = /^([A-Za-z0-9-]+):[ \t]*(.*)$/;

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function strictBase64(encoded: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    return null;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.toString("base64") === encoded ? decoded : null;
}

/** The bare address of exactly one mailbox, `addr` or `Name <addr>`. A display
 * name is printable ASCII without `,<>"`: a quoted name is refused rather than
 * parsed, so no spelling of the value can carry a second address. */
function mailboxAddress(value: string): string | null {
  if (mailbox.safeParse(value).success) return value;
  const named = /^([^<>]*?)[ \t]*<([^<>]*)>$/.exec(value);
  if (!named) return null;
  const name = named[1]!;
  if (!name.trim() || !/^[\x20-\x7e]+$/.test(name) || /[,<>"]/.test(name)) return null;
  return mailbox.safeParse(named[2]).success ? named[2]! : null;
}

/** One mailbox too many is a different finding from a malformed one, because
 * its remedy is different. */
function addressRefusal(
  value: string,
  invalid: "sender_invalid" | "recipient_invalid",
): ReportMessageRefusal {
  const pieces = value.split(",").map((piece) => piece.trim());
  return invalid === "recipient_invalid" &&
    pieces.length > 1 &&
    pieces.every((piece) => mailboxAddress(piece) !== null)
    ? "extra_recipients"
    : invalid;
}

/** The subject as a reader sees it. It routes nothing, so a value that is not
 * wholly encoded words is shown as written. */
function subjectText(words: string[]): string {
  const bytes: Buffer[] = [];
  for (const word of words) {
    const payload = ENCODED_WORD.exec(word)?.[1];
    const decoded = payload ? strictBase64(payload) : null;
    if (!decoded) return words.join(" ");
    bytes.push(decoded);
  }
  return strictUtf8(Buffer.concat(bytes)) ?? words.join(" ");
}

function decodeBody(body: string, encoding: string | undefined): { text: string } | Refused {
  if (encoding !== "base64") return { text: body };
  const decoded = strictBase64(body.replace(/\r\n/g, ""));
  if (!decoded) return refuse("body_not_base64");
  const text = strictUtf8(decoded);
  return text === null ? refuse("not_utf8") : { text };
}

/** One part of a multipart/alternative report: a single text body with only
 * its type and transfer encoding. No nesting, no disposition, nothing else. */
function inspectPart(part: string): { type: string; text: string } | Refused {
  const end = part.indexOf("\r\n\r\n");
  if (end < 0) return refuse("multipart_unsupported");
  const headers = new Map<string, string>();
  for (const line of part.slice(0, end).split("\r\n")) {
    if (CONTROL_BYTE.test(line)) return refuse("header_control_byte");
    if (/^[ \t]/.test(line)) return refuse("header_folded");
    const field = FIELD.exec(line);
    const key = field?.[1]?.toLowerCase();
    if (!field || !key || !PART_HEADERS.has(key)) return refuse("multipart_unsupported");
    if (headers.has(key)) return refuse("header_duplicate");
    headers.set(key, field[2]!.trim());
  }
  const contentType = headers.get("content-type");
  const type = TEXT_TYPE.exec(contentType ?? "");
  if (!type)
    return refuse(
      contentType === undefined || /^multipart\//i.test(contentType)
        ? "multipart_unsupported"
        : "content_type_unsupported",
    );
  const encoding = headers.get("content-transfer-encoding")?.toLowerCase();
  if (encoding !== undefined && !TRANSFER_ENCODINGS.has(encoding))
    return refuse("transfer_encoding_unsupported");
  const body = decodeBody(part.slice(end + 4), encoding);
  return "ok" in body ? body : { type: type[1]!.toLowerCase(), text: body.text };
}

/** Exactly two parts, text/plain then text/html, between one opening and one
 * closing delimiter: no preamble, and nothing after the close but an empty
 * line. Yields the HTML part, which is what the reader sees. */
function inspectAlternative(body: string, boundary: string): { text: string } | Refused {
  const open = `--${boundary}\r\n`;
  const separator = `\r\n--${boundary}\r\n`;
  const close = `\r\n--${boundary}--`;
  if (!body.startsWith(open)) return refuse("multipart_unsupported");
  const closeAt = body.indexOf(close, open.length);
  if (closeAt < 0) return refuse("multipart_unsupported");
  const tail = body.slice(closeAt + close.length);
  if (tail !== "" && tail !== "\r\n") return refuse("multipart_unsupported");
  const parts = body.slice(open.length, closeAt).split(separator);
  if (parts.length !== 2 || parts.some((part) => part.includes(`\r\n--${boundary}`)))
    return refuse("multipart_unsupported");
  const plain = inspectPart(parts[0]!);
  if ("ok" in plain) return plain;
  const html = inspectPart(parts[1]!);
  if ("ok" in html) return html;
  if (plain.type !== "text/plain" || html.type !== "text/html")
    return refuse("multipart_unsupported");
  return { text: html.text };
}

/** Narrow MIME profile, shared by proposal and dispatch. Unsupported MIME is
 * not guessed: additional recipients, folded or duplicate headers, attachments,
 * nested parts, forwarding headers and encoded addresses all require
 * concrete-run review. What it accepts is what sk.buildMimeMessage produces for
 * one sender and one recipient: a named or bare mailbox, a subject folded into
 * whole encoded words, and a single text body or a text/plain + text/html
 * alternative. Only the extracted addresses are compared, never display names. */
export function inspectReportMessage(body: unknown): ReportMessageInspection {
  let value: unknown;
  try {
    value = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return refuse("not_json_raw");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { raw?: unknown }).raw !== "string" ||
    (value as { raw: string }).raw.length > 1_000_000
  )
    return refuse("not_json_raw");
  const raw = (value as { raw: string }).raw;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return refuse("not_base64url");
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.toString("base64url") !== raw.replace(/=+$/, "")) return refuse("not_base64url");
  const message = strictUtf8(bytes);
  if (message === null) return refuse("not_utf8");
  const end = message.indexOf("\r\n\r\n");
  if (end < 0 || end > 16_384) return refuse("missing_headers");

  const headers = new Map<string, string>();
  const subjectWords: string[] = [];
  let previous: string | null = null;
  for (const line of message.slice(0, end).split("\r\n")) {
    if (CONTROL_BYTE.test(line)) return refuse("header_control_byte");
    if (/^[ \t]/.test(line)) {
      // Only the subject may continue, and only as whole encoded words: the
      // shape sk.buildMimeMessage emits, and one no other header can hide in.
      const word = line.slice(1);
      if (previous !== "subject" || line[0] !== " " || !ENCODED_WORD.test(word))
        return refuse("header_folded");
      subjectWords.push(word);
      continue;
    }
    const field = FIELD.exec(line);
    const key = field?.[1]?.toLowerCase();
    if (!field || !key || !ENVELOPE_HEADERS.has(key)) return refuse("header_not_allowed");
    if (headers.has(key)) return refuse("header_duplicate");
    const fieldValue = field[2]!.trim();
    headers.set(key, fieldValue);
    if (key === "subject") subjectWords.push(fieldValue);
    previous = key;
  }
  const from = headers.get("from");
  const to = headers.get("to");
  const contentType = headers.get("content-type");
  if (
    from === undefined ||
    to === undefined ||
    contentType === undefined ||
    !headers.has("subject") ||
    headers.get("mime-version") !== "1.0"
  )
    return refuse("missing_headers");
  // A folded subject is encoded words throughout, never text that happens to
  // continue on one.
  if (subjectWords.length > 1 && !ENCODED_WORD.test(subjectWords[0]!))
    return refuse("header_folded");

  const sender = mailboxAddress(from);
  if (!sender) return refuse(addressRefusal(from, "sender_invalid"));
  const recipient = mailboxAddress(to);
  if (!recipient) return refuse(addressRefusal(to, "recipient_invalid"));

  const encoding = headers.get("content-transfer-encoding")?.toLowerCase();
  if (encoding !== undefined && !TRANSFER_ENCODINGS.has(encoding))
    return refuse("transfer_encoding_unsupported");
  const single = TEXT_TYPE.exec(contentType);
  const alternative = single ? null : ALTERNATIVE_TYPE.exec(contentType);
  let content: ReportDeliveryBoundary["content_type"];
  let decoded: { text: string } | Refused;
  if (single) {
    content = single[1]!.toLowerCase() as "text/plain" | "text/html";
    decoded = decodeBody(message.slice(end + 4), encoding);
  } else if (alternative) {
    const delimiter = alternative[1] ?? alternative[2]!;
    if (!BOUNDARY.test(delimiter)) return refuse("multipart_unsupported");
    // The parts carry their own encoding; the container is never encoded.
    if (encoding === "base64") return refuse("transfer_encoding_unsupported");
    content = "multipart/alternative";
    decoded = inspectAlternative(message.slice(end + 4), delimiter);
  } else
    return refuse(
      /^multipart\//i.test(contentType) ? "multipart_unsupported" : "content_type_unsupported",
    );
  if ("ok" in decoded) return decoded;
  return {
    ok: true,
    boundary: { kind: "gmail_report", to: recipient, from: sender, content_type: content },
    subject: subjectText(subjectWords),
    text: decoded.text,
  };
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
