import { homedir } from "node:os";
import { appendError, type ErrorEntry } from "../shared/redaction.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

function load(path: string): ErrorEntry[] {
  const raw = readJson(path);
  if (!Array.isArray(raw)) return [];
  let log: ErrorEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { at, scope, message } = item as Record<string, unknown>;
    if (typeof at !== "string" || typeof scope !== "string" || typeof message !== "string")
      continue;
    log = appendError(log, { at, scope, message }, homedir());
  }
  return log;
}

export class ErrorLog {
  private log: ErrorEntry[];

  constructor(private readonly path: string) {
    this.log = load(path);
  }

  get entries(): readonly ErrorEntry[] {
    return this.log;
  }

  record(scope: string, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.log = appendError(this.log, { at: new Date().toISOString(), scope, message }, homedir());
    try {
      writeJsonAtomic(this.path, this.log);
    } catch {}
  }
}
