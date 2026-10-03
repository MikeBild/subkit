// Files that travel with a chat message.
//
// The engine keeps a conversation's files as links (`file_links`) under a
// slug, and a message names one by writing `@attachment:<slug>`; on the way
// in it becomes the sentinel `[file:fid_…]`, which is what a stored message
// carries. So sending with files is: make sure the conversation exists, link
// each file (a fresh upload, or a file the tenant already holds), then send
// the text with one token per file. Reading back is the reverse: the
// sentinels become chips and leave the prose.

import { toast } from "sonner";
import { apiRequest, type Conversation } from "@/api/client";
import { fileRefusal, formatBytes } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";

/** The most one file may weigh: the engine's inline upload cap. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** A file waiting in the composer: picked or dropped here, or chosen with `@`. */
export type PendingAttachment =
  | { key: string; kind: "upload"; file: File }
  | {
      key: string;
      kind: "file";
      /** The engine's file id, `fid_…`. */
      id: string;
      name: string;
      size?: number;
      contentType?: string | null;
    };

/** A linked file as the engine lists it for a conversation. */
export interface ConversationAttachment {
  id: string;
  slug: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
}

export function attachmentName(attachment: PendingAttachment): string {
  return attachment.kind === "upload" ? attachment.file.name : attachment.name;
}

export function attachmentSize(attachment: PendingAttachment): number | undefined {
  return attachment.kind === "upload" ? attachment.file.size : attachment.size;
}

let counter = 0;
/** A key for a pending file that stays put while the list around it changes. */
export function pendingKey(): string {
  counter += 1;
  return `attachment-${counter}`;
}

/** Add files to the pending list; a stored file chosen twice stands once. */
export function addAttachments(
  current: readonly PendingAttachment[],
  next: readonly PendingAttachment[],
): PendingAttachment[] {
  const out = [...current];
  for (const attachment of next) {
    if (
      attachment.kind === "file" &&
      out.some((existing) => existing.kind === "file" && existing.id === attachment.id)
    )
      continue;
    out.push(attachment);
  }
  return out;
}

/**
 * The picked, dropped or pasted files that may go: one too large is named in
 * a toast and left out, so a send never fails on it later.
 */
export function takeAttachmentFiles(
  files: readonly File[],
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): PendingAttachment[] {
  const taken: PendingAttachment[] = [];
  for (const file of files) {
    if (fileRefusal(file, { maxBytes: MAX_ATTACHMENT_BYTES }) === "size")
      toast.error(
        t("platform.file.tooLarge", { name: file.name, max: formatBytes(MAX_ATTACHMENT_BYTES) }),
      );
    else taken.push({ key: pendingKey(), kind: "upload", file });
  }
  return taken;
}

/** The message as sent: the person's text, then one token per linked file. */
export function messageWithAttachments(text: string, slugs: readonly string[]): string {
  if (slugs.length === 0) return text;
  const tokens = slugs.map((slug) => `@attachment:${slug}`).join(" ");
  return text ? `${text}\n\n${tokens}` : tokens;
}

const SENTINEL = /\[file:(fid_[0-9a-f-]{36})\]/g;

/**
 * A stored message's text without its file sentinels, and the files they
 * named, in order. The prose reads as the person wrote it; the files stand
 * beside it as chips.
 */
export function splitFileSentinels(text: string): { text: string; fileIds: string[] } {
  const fileIds: string[] = [];
  const stripped = text.replace(SENTINEL, (_, id: string) => {
    if (!fileIds.includes(id)) fileIds.push(id);
    return "";
  });
  return { text: fileIds.length > 0 ? stripped.trim() : text, fileIds };
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Link one pending file to the conversation; resolves to its slug. */
export async function linkAttachment(
  conversationId: string,
  attachment: PendingAttachment,
): Promise<string> {
  const body =
    attachment.kind === "file"
      ? { $file: attachment.id }
      : {
          filename: attachment.file.name,
          ...(attachment.file.type ? { content_type: attachment.file.type } : {}),
          content_base64: await base64(attachment.file),
        };
  const linked = await apiRequest<{ slug: string }>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/attachments`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return linked.slug;
}

/**
 * Open a conversation without a turn, so files can be linked to it before
 * the first message names them.
 */
export async function createEmptyConversation(input: {
  target?: { workflow_id?: string; connector_id?: string };
  permissionMode?: "auto" | "ask" | "plan";
}): Promise<Conversation> {
  const created = await apiRequest<{ conversation: Conversation }>("/v1/conversations", {
    method: "POST",
    body: JSON.stringify({
      ...(input.target ?? {}),
      ...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
    }),
  });
  return created.conversation;
}

export function listConversationAttachments(
  conversationId: string,
): Promise<{ attachments: ConversationAttachment[] }> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(conversationId)}/attachments`);
}

/** Where a stored file's bytes are read from. */
export function fileContentHref(fileId: string): string {
  return `/v1/files/${encodeURIComponent(fileId)}/content`;
}
