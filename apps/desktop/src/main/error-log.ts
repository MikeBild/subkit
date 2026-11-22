import { homedir } from "node:os";
import { appendError, type ErrorEntry, redactKnown } from "../shared/diagnostics.ts";
import { type AppLog, appLog } from "./app-log.ts";
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
  private readonly secrets = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly sink: AppLog = appLog,
  ) {
    this.log = load(path);
  }

  get entries(): readonly ErrorEntry[] {
    return this.log;
  }

  addSecret(secret: string): void {
    this.secrets.add(secret);
    this.sink.addSecret(secret);
    this.log = this.log.map((entry) => ({
      ...entry,
      message: redactKnown(entry.message, [secret]),
    }));
  }

  record(scope: string, error: unknown): void {
    this.sink.error(scope, error);
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const message = redactKnown(raw, [...this.secrets]);
    this.log = appendError(this.log, { at: new Date().toISOString(), scope, message }, homedir());
    try {
      writeJsonAtomic(this.path, this.log);
    } catch {}
  }
}
