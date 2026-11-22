import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  errorFields,
  formatLogLine,
  LOG_FILE,
  LOG_KEEP,
  LOG_MAX_BYTES,
  type LogLevel,
  type LogValue,
  rotatedName,
  rotationPlan,
  tailLines,
} from "../shared/app-log.ts";

const PENDING_LIMIT = 500;

export class AppLog {
  private folder: string | null = null;
  private pending: string[] = [];
  private readonly secrets = new Set<string>();

  constructor(
    private readonly limits = { maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP },
    private readonly now: () => Date = () => new Date(),
  ) {}

  get directory(): string | null {
    return this.folder;
  }

  open(folder: string): void {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.folder = folder;
    const pending = this.pending;
    this.pending = [];
    for (const line of pending) this.write(line);
  }

  addSecret(secret: string): void {
    this.secrets.add(secret);
  }

  knownSecrets(): string[] {
    return [...this.secrets];
  }

  info(event: string, fields?: Record<string, LogValue>): void {
    this.line("info", event, fields);
  }

  warn(event: string, fields?: Record<string, LogValue>): void {
    this.line("warn", event, fields);
  }

  error(event: string, error: unknown, fields?: Record<string, LogValue>): void {
    this.line("error", event, { ...fields, ...errorFields(error) });
  }

  tail(count: number): string[] {
    const folder = this.folder;
    if (!folder) return tailLines(this.pending, count);
    const texts: string[] = [];
    for (let index = 1; index >= 0; index--) {
      const path = join(folder, rotatedName(index));
      try {
        texts.push(readFileSync(path, "utf8"));
      } catch {}
    }
    return tailLines(texts, count);
  }

  private line(level: LogLevel, event: string, fields?: Record<string, LogValue>): void {
    const text = formatLogLine(
      { at: this.now().toISOString(), level, event, fields },
      { secrets: [...this.secrets], homeDir: homedir() },
    );
    if (!this.folder) {
      this.pending = [...this.pending, text].slice(-PENDING_LIMIT);
      return;
    }
    this.write(text);
  }

  private write(text: string): void {
    const folder = this.folder;
    if (!folder) return;
    const line = `${text}\n`;
    try {
      const path = join(folder, LOG_FILE);
      const size = fileSize(path);
      for (const step of rotationPlan(size, Buffer.byteLength(line), this.limits)) {
        const from = join(folder, step.from);
        if (step.to === null) rmSync(from, { force: true });
        else renameIfPresent(from, join(folder, step.to));
      }
      appendFileSync(path, line, { mode: 0o600 });
    } catch {}
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export const appLog = new AppLog();
