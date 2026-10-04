import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { trimJsonlFile } from "@shared/jsonl-ring.ts";
import { debugLog, serializeDebugError } from "../../debug.ts";
import { detectSecretShape } from "../../lib/secret-shape.ts";

export const MAX_EVENTS_PER_SESSION = 5_000;

export type TurnEventKind =
  | "user_message"
  | "assistant_delta"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "error"
  | "completed"
  | "cancelled";

export interface TurnEvent {
  seq: number;
  ts: string;
  kind: TurnEventKind;
  tenant: string;
  data: Record<string, unknown>;
}

export function scrubSecrets(data: unknown): unknown {
  if (typeof data === "string") {
    const shape = detectSecretShape(data);
    return shape.matched ? "***redacted***" : data;
  }
  if (Array.isArray(data)) return data.map(scrubSecrets);
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = scrubSecrets(v);
    }
    return out;
  }
  return data;
}

export interface AppendOptions {
  dir?: string;
  tenant: string;
  now?: () => Date;
}

export function sessionsDir(override?: string): string {
  return override ?? join(homedir(), ".sk", "sessions");
}

export function sessionEventsPath(
  conversationId: string,
  dir: string | undefined,
  tenant: string,
): string {
  const safe = tenant.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(sessionsDir(dir), safe, `${conversationId}.jsonl`);
}

export function appendEvent(
  conversationId: string,
  ev: Omit<TurnEvent, "ts" | "tenant">,
  opts: AppendOptions,
): void {
  if (!opts.tenant || opts.tenant.length === 0) {
    throw new Error("appendEvent: opts.tenant is required and must be non-empty");
  }
  const path = sessionEventsPath(conversationId, opts.dir, opts.tenant);
  const now = opts.now ?? (() => new Date());
  const scrubbedData = scrubSecrets(ev.data) as Record<string, unknown>;
  const event: TurnEvent = {
    ...ev,
    data: scrubbedData,
    ts: now().toISOString(),
    tenant: opts.tenant,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    if (statSync(path).size > MAX_EVENTS_PER_SESSION * 256) {
      maybeTrimJsonl(path, MAX_EVENTS_PER_SESSION);
    }
  } catch (err) {
    debugLog("session.append_failed", { path, error: serializeDebugError(err) }, {});
  }
}

function maybeTrimJsonl(path: string, keep: number): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  trimJsonlFile(path, content, Math.floor(keep / 2));
}

export function loadEvents(
  conversationId: string,
  dir: string | undefined,
  tenant: string,
): TurnEvent[] {
  if (!tenant || tenant.length === 0) {
    throw new Error("loadEvents: tenant is required and must be non-empty");
  }
  return readJsonlEvents(sessionEventsPath(conversationId, dir, tenant));
}

export function deleteEvents(
  conversationId: string,
  dir: string | undefined,
  tenant: string,
): void {
  if (!tenant || tenant.length === 0) {
    throw new Error("deleteEvents: tenant is required and must be non-empty");
  }
  try {
    unlinkSync(sessionEventsPath(conversationId, dir, tenant));
  } catch {}
}

function readJsonlEvents(path: string): TurnEvent[] {
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const events: TurnEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as TurnEvent;
      if (
        typeof ev.seq === "number" &&
        typeof ev.kind === "string" &&
        typeof ev.tenant === "string"
      ) {
        events.push(ev);
      }
    } catch {}
  }
  return events;
}
