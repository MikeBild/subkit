import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionMetadata {
  conversation_id: string;
  engine_url: string;
  tenant_id: string | null;
  title: string | null;
  model: string | null;
  created_at: string;
  last_used_at: string;
  alias?: string | null;
}

export function resolveSessionRef(
  ref: string,
  filter?: { engine_url?: string; tenant_id?: string | null },
): SessionMetadata | null {
  const direct = loadSessionMetadata(ref);
  if (direct) {
    if (filter?.engine_url && direct.engine_url !== filter.engine_url) return null;
    if (filter?.tenant_id !== undefined && direct.tenant_id !== filter.tenant_id) {
      return null;
    }
    return direct;
  }
  for (const meta of listSessionMetadata(filter)) {
    if (meta.alias === ref) return meta;
  }
  return null;
}

export function sessionsDir(): string {
  const override = process.env.SUBKIT_HOME;
  if (override && override.length > 0) {
    return join(override, "sessions");
  }
  return join(homedir(), ".subkit", "sessions");
}

export function sessionPath(conversation_id: string): string {
  return join(sessionsDir(), `${conversation_id}.json`);
}

function ensureDir(): void {
  const dir = sessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {}
  }
}

export function saveSessionMetadata(meta: SessionMetadata): void {
  ensureDir();
  const path = sessionPath(meta.conversation_id);
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function loadSessionMetadata(conversation_id: string): SessionMetadata | null {
  const path = sessionPath(conversation_id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionMetadata;
  } catch {
    return null;
  }
}

export function listSessionMetadata(filter?: {
  engine_url?: string;
  tenant_id?: string | null;
}): SessionMetadata[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const entries: SessionMetadata[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const meta = JSON.parse(readFileSync(full, "utf8")) as SessionMetadata;
      if (filter?.engine_url && meta.engine_url !== filter.engine_url) continue;
      if (filter?.tenant_id !== undefined && meta.tenant_id !== filter.tenant_id) continue;
      entries.push(meta);
    } catch {}
  }
  entries.sort((a, b) => (a.last_used_at < b.last_used_at ? 1 : -1));
  return entries;
}

export function mostRecentSession(filter: {
  engine_url: string;
  tenant_id: string | null;
}): SessionMetadata | null {
  const all = listSessionMetadata(filter);
  return all[0] ?? null;
}
