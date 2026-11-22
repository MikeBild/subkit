import { type RedactContext, redactLogText } from "./diagnostics.ts";

export const LOG_FILE = "subkit.log";
export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_KEEP = 4;
export const LOG_LINE_MAX = 2000;

export type LogLevel = "info" | "warn" | "error";

export type LogValue = string | number | boolean | null | undefined;

export interface LogEntry {
  at: string;
  level: LogLevel;
  event: string;
  fields?: Readonly<Record<string, LogValue>> | undefined;
}

function fieldValue(value: LogValue): string {
  if (value === undefined || value === null) return "-";
  const text = String(value).replace(/\s+/g, " ");
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text);
}

export function formatLogLine(entry: LogEntry, context: RedactContext): string {
  const fields = Object.entries(entry.fields ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${fieldValue(value)}`);
  const raw = [entry.at, entry.level.toUpperCase().padEnd(5), entry.event, ...fields]
    .join(" ")
    .replace(/[\r\n]+/g, " ");
  return redactLogText(raw, context).slice(0, LOG_LINE_MAX);
}

export function errorFields(error: unknown): Record<string, LogValue> {
  if (!(error instanceof Error)) return { error: String(error) };
  const code = (error as { code?: unknown }).code;
  const frame = error.stack?.split("\n").find((line) => line.trim().startsWith("at "));
  return {
    error: `${error.name}: ${error.message}`,
    error_code: typeof code === "string" || typeof code === "number" ? code : undefined,
    frame: frame?.trim().slice(3),
  };
}

export function rotatedName(index: number): string {
  return index === 0 ? LOG_FILE : `${LOG_FILE}.${index}`;
}

export interface RotationStep {
  from: string;
  to: string | null;
}

export function rotationPlan(
  currentBytes: number,
  incomingBytes: number,
  limits: { maxBytes: number; keep: number } = { maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP },
): RotationStep[] {
  if (currentBytes === 0 || currentBytes + incomingBytes <= limits.maxBytes) return [];
  const steps: RotationStep[] = [{ from: rotatedName(limits.keep), to: null }];
  for (let index = limits.keep - 1; index >= 0; index--)
    steps.push({ from: rotatedName(index), to: rotatedName(index + 1) });
  return steps;
}

export function tailLines(texts: readonly string[], count: number): string[] {
  const lines = texts.flatMap((text) => text.split("\n")).filter((line) => line.length > 0);
  return count > 0 ? lines.slice(-count) : [];
}
