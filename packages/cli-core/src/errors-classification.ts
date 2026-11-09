export interface EngineErrorShape extends Error {
  readonly status: number;
  readonly code: string;
  readonly trace_id: string | null;
  readonly hint: string | null;
  readonly retry_after: number | null;
  readonly details: unknown;
  readonly body: unknown;
}

export interface TransportErrorShape extends Error {
  readonly cause_message: string;
  readonly cause: unknown;
}

export function isEngineError(err: unknown): err is EngineErrorShape {
  return (
    err instanceof Error &&
    err.name === "EngineError" &&
    typeof (err as EngineErrorShape).status === "number"
  );
}

export function isTransportError(err: unknown): err is TransportErrorShape {
  return err instanceof Error && err.name === "TransportError";
}

export function formatError(err: unknown): string {
  if (isEngineError(err)) {
    const trace = err.trace_id ? ` [trace=${err.trace_id}]` : "";
    return `${err.code}: ${err.message}${trace}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function exitCodeFor(err: unknown): number {
  if (isEngineError(err)) {
    if (err.status === 400 || err.status === 409 || err.status === 422) return 1;
    return 2;
  }
  if (isTransportError(err)) return 2;
  return 1;
}

export function engineErrorDetailLines(details: unknown): string[] {
  if (!details || typeof details !== "object") return [];
  const d = details as Record<string, unknown>;
  const lines: string[] = [];
  if (Array.isArray(d.formErrors)) {
    for (const m of d.formErrors) if (typeof m === "string" && m) lines.push(m);
  }
  if (d.fieldErrors && typeof d.fieldErrors === "object") {
    for (const [field, msgs] of Object.entries(d.fieldErrors as Record<string, unknown>)) {
      const list = Array.isArray(msgs) ? msgs.filter((m) => typeof m === "string") : [];
      for (const m of list) lines.push(`${field}: ${m}`);
    }
  }
  if (Array.isArray(d.issues)) {
    for (const i of d.issues) {
      if (!i || typeof i !== "object") continue;
      const issue = i as Record<string, unknown>;
      const path = Array.isArray(issue.path) ? issue.path.join(".") : issue.path;
      if (typeof issue.message === "string") {
        lines.push(path ? `${String(path)}: ${issue.message}` : issue.message);
      }
    }
  }
  return lines;
}
