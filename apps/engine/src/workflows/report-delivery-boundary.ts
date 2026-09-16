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
    content_type: z.enum(["text/plain", "text/html"]),
  })
  .strict();
export type ReportDeliveryBoundary = z.infer<typeof ReportDeliveryBoundarySchema>;
export const GMAIL_SEND_TARGET = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** Narrow MIME profile, shared by proposal and dispatch. Unsupported MIME is
 * not guessed: additional recipients, folded/duplicate headers, attachments,
 * forwarding headers and encoded addresses all require concrete-run review. */
export function inspectReportMessage(body: unknown): {
  boundary: ReportDeliveryBoundary;
  subject: string;
  text: string;
} | null {
  try {
    const value = typeof body === "string" ? JSON.parse(body) : body;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.raw !== "string" ||
      value.raw.length > 1_000_000 ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(value.raw)
    )
      return null;
    const bytes = Buffer.from(value.raw, "base64url");
    if (bytes.toString("base64url") !== value.raw.replace(/=+$/, "")) return null;
    const message = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const end = message.indexOf("\r\n\r\n");
    if (end < 0 || end > 16_384) return null;
    const headers = new Map<string, string>();
    for (const line of message.slice(0, end).split("\r\n")) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject ambiguous MIME control bytes
      const match = /^([A-Za-z-]+):[ \t]*([^\r\n\x00-\x1f\x7f]*)$/.exec(line);
      if (!match) return null;
      const key = match[1]!.toLowerCase();
      if (
        headers.has(key) ||
        ![
          "from",
          "to",
          "subject",
          "mime-version",
          "content-type",
          "content-transfer-encoding",
        ].includes(key)
      )
        return null;
      headers.set(key, match[2]!.trim());
    }
    if (headers.get("mime-version") !== "1.0" || !headers.has("subject")) return null;
    const content = /^(text\/(?:plain|html))(?:;\s*charset="?utf-8"?)?$/i.exec(
      headers.get("content-type") ?? "",
    );
    if (
      !content ||
      (headers.has("content-transfer-encoding") &&
        !["7bit", "8bit"].includes(headers.get("content-transfer-encoding")!))
    )
      return null;
    const parsed = ReportDeliveryBoundarySchema.safeParse({
      kind: "gmail_report",
      to: headers.get("to"),
      from: headers.get("from"),
      content_type: content[1]!.toLowerCase(),
    });
    if (!parsed.success) return null;
    return {
      boundary: parsed.data,
      subject: headers.get("subject")!,
      text: message.slice(end + 4),
    };
  } catch {
    return null;
  }
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

export function assertReportDelivery(
  boundary: ReportDeliveryBoundary,
  request: MaterializedRequest | undefined,
): void {
  const message = request && !request.unsupported_body ? inspectReportMessage(request.body) : null;
  const url = request ? new URL(request.url) : null;
  if (
    request?.method !== "POST" ||
    !url ||
    url.href !== GMAIL_SEND_TARGET ||
    !message ||
    message.boundary.to !== boundary.to ||
    message.boundary.from !== boundary.from ||
    message.boundary.content_type !== boundary.content_type
  ) {
    throw Object.assign(
      new Error("Report delivery differs from the reviewed sender, recipient or message format"),
      { code: "execution_authority_changed" },
    );
  }
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
