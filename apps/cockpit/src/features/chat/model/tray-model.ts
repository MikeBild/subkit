import type { components } from "@cli-core/engine-api/openapi";
import { type FileKind, fileKindOf } from "@shared/file-kinds.ts";

type ConversationAttachment = components["schemas"]["ConversationAttachment"];

export type TrayFile = Pick<
  ConversationAttachment,
  "id" | "filename" | "content_type" | "size_bytes" | "status" | "slug"
>;

export type TrayItem = {
  id: string;
  file: TrayFile;
  staged_at: string;
  expires_at: string;
};

export type TrayChip = {
  id: string;
  fileId: string;
  name: string;
  size: number;
  kind: FileKind;
  contentType: string | null;
};

export type TrayProblemReason = "expired" | "scan_failed";

export type TrayProblem = { id: string; name: string; reason: TrayProblemReason };

export type TrayMemory = { known: readonly TrayItem[]; seen: readonly string[] };

export const EMPTY_TRAY_MEMORY: TrayMemory = { known: [], seen: [] };

export const TRAY_PROBLEM_CODE: Record<TrayProblemReason, string> = {
  expired: "composer_attachment_expired",
  scan_failed: "file_rejected",
};

function expired(item: TrayItem, now: number): boolean {
  const until = Date.parse(item.expires_at);
  return item.file.status === "expired" || (Number.isFinite(until) && until <= now);
}

function failed(item: TrayItem): boolean {
  return item.file.status === "failed";
}

function problemOf(item: TrayItem, now: number): TrayProblem | null {
  if (failed(item)) return { id: item.id, name: item.file.filename, reason: "scan_failed" };
  if (expired(item, now)) return { id: item.id, name: item.file.filename, reason: "expired" };
  return null;
}

export function trayChips(
  items: readonly TrayItem[],
  now: number,
  hidden: ReadonlySet<string> = new Set(),
): TrayChip[] {
  return items
    .filter((item) => !hidden.has(item.id) && problemOf(item, now) === null)
    .map((item) => ({
      id: item.id,
      fileId: item.file.id,
      name: item.file.filename,
      size: item.file.size_bytes,
      kind: fileKindOf(item.file.filename),
      contentType: item.file.content_type,
    }));
}

export function observeTray(
  memory: TrayMemory,
  items: readonly TrayItem[],
  now: number,
  removed: ReadonlySet<string> = new Set(),
): { memory: TrayMemory; fresh: TrayProblem[] } {
  const listed = new Set(items.map((item) => item.id));
  const vanished = memory.known
    .filter((item) => !listed.has(item.id) && !removed.has(item.id) && expired(item, now))
    .map((item): TrayProblem => ({ id: item.id, name: item.file.filename, reason: "expired" }));
  const present = items.flatMap((item) => problemOf(item, now) ?? []);
  const seen = new Set(memory.seen);
  const fresh: TrayProblem[] = [];
  for (const problem of [...present, ...vanished]) {
    if (seen.has(problem.id)) continue;
    seen.add(problem.id);
    fresh.push(problem);
  }
  return { memory: { known: [...items], seen: [...seen] }, fresh };
}

export function mergeProblems(
  current: readonly TrayProblem[],
  fresh: readonly TrayProblem[],
): TrayProblem[] {
  const ids = new Set(current.map((problem) => problem.id));
  return [...current, ...fresh.filter((problem) => !ids.has(problem.id))];
}

export function problemTone(problems: readonly TrayProblem[]): "danger" | "warning" {
  return problems.some((problem) => problem.reason === "scan_failed") ? "danger" : "warning";
}

export function problemCodes(problems: readonly TrayProblem[]): string {
  return [...new Set(problems.map((problem) => TRAY_PROBLEM_CODE[problem.reason]))].join(", ");
}

export function failedIds(problems: readonly TrayProblem[]): string[] {
  return problems.filter((problem) => problem.reason === "scan_failed").map(({ id }) => id);
}

export function claimBody(
  conversationId: string,
  ids: readonly string[],
): { conversation_id: string; ids: string[] } | null {
  return ids.length > 0 ? { conversation_id: conversationId, ids: [...ids] } : null;
}

export type ClaimedFile = {
  id: string;
  slug: string;
  name: string;
  size: number;
  contentType: string | null;
};

export function claimedFiles(result: {
  attachments: readonly Pick<
    ConversationAttachment,
    "id" | "slug" | "filename" | "size_bytes" | "content_type"
  >[];
}): ClaimedFile[] {
  return result.attachments.map((attachment) => ({
    id: attachment.id,
    slug: attachment.slug,
    name: attachment.filename,
    size: attachment.size_bytes,
    contentType: attachment.content_type,
  }));
}

export function claimedAsPending(
  files: readonly ClaimedFile[],
  key: () => string,
): {
  key: string;
  kind: "file";
  id: string;
  name: string;
  size: number;
  contentType: string | null;
}[] {
  return files.map((file) => ({
    key: key(),
    kind: "file",
    id: file.id,
    name: file.name,
    size: file.size,
    contentType: file.contentType,
  }));
}

export function trayUnavailable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  return status === 404 || status === 405 || (status === 403 && code === "person_required");
}
