import { scrubString } from "@shared/redaction.ts";
import { scrubUrl } from "../connectors/egress.ts";

export const RESULT_MARKDOWN_MAX_BYTES = 65_536;
export const RESULT_MARKDOWN_FIELD = "result_markdown";
export const MARKDOWN_MEDIA_TYPE = "text/markdown";

export type MarkdownSource = { kind: "root" } | { kind: "field"; name: string };

export interface ResultMarkdown {
  markdown: string;
  truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function marksMarkdown(schema: unknown): boolean {
  const node = record(schema);
  if (!node) return false;
  const media = node.contentMediaType;
  return typeof media === "string" && media.toLowerCase() === MARKDOWN_MEDIA_TYPE;
}

export function declaredMarkdownSource(outputSchema: unknown): MarkdownSource | null {
  if (marksMarkdown(outputSchema)) return { kind: "root" };
  const properties = record(record(outputSchema)?.properties);
  if (!properties) return null;
  const name = Object.keys(properties).find((key) => marksMarkdown(properties[key]));
  return name ? { kind: "field", name } : null;
}

export function pickResultMarkdown(output: unknown, outputSchema: unknown): string | null {
  const source = declaredMarkdownSource(outputSchema) ?? {
    kind: "field",
    name: RESULT_MARKDOWN_FIELD,
  };
  const value = source.kind === "root" ? output : record(output)?.[source.name];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"'`]+/g;

const SECRET_OUTPUT_MASK = "***REDACTED:secret_output***";
const MIN_SECRET_CHARS = 4;

function secretKeysOf(step: Record<string, unknown>): string[] {
  const outputs = record(step.outputs);
  if (step.kind !== "request" || !outputs) return [];
  return Object.keys(outputs).filter((key) => record(outputs[key])?.secret === true);
}

function requestSteps(
  node: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const child of node) requestSteps(child, found);
    return found;
  }
  const step = record(node);
  if (!step) return found;
  if (step.kind === "request" && typeof step.id === "string") found.push(step);
  for (const value of Object.values(step))
    if (typeof value === "object") requestSteps(value, found);
  return found;
}

export function declaredSecretValues(steps: unknown, scope: Record<string, unknown>): string[] {
  const values = new Set<string>();
  for (const step of requestSteps(steps)) {
    const data = record(record(scope[step.id as string])?.data);
    if (!data) continue;
    for (const key of secretKeysOf(step)) {
      const value = data[key];
      if (typeof value === "string" && value.length >= MIN_SECRET_CHARS) values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactResultMarkdown(markdown: string, secrets: readonly string[] = []): string {
  const masked = secrets.reduce(
    (text, secret) => text.split(secret).join(SECRET_OUTPUT_MASK),
    markdown,
  );
  return scrubString(masked.replace(URL_IN_TEXT, (url) => scrubUrl(url)));
}

const isUtf8Continuation = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;

/** Longest prefix whose UTF-8 encoding fits in maxBytes, never splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): ResultMarkdown {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return { markdown: text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && isUtf8Continuation(encoded[end])) end--;
  return { markdown: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true };
}

export function resultMarkdown(
  output: unknown,
  outputSchema: unknown,
  secrets: readonly string[] = [],
  maxBytes = RESULT_MARKDOWN_MAX_BYTES,
): ResultMarkdown | null {
  const picked = pickResultMarkdown(output, outputSchema);
  if (picked === null) return null;
  return truncateUtf8(redactResultMarkdown(picked, secrets), maxBytes);
}
