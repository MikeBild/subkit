import { extOf } from "@ui/lib/file-kinds";

export type DropVia = "window" | "dock" | "tray";
export type DropChoice = "file" | "source" | "chat" | "inbox";
export const DROP_CHOICES: readonly DropChoice[] = ["file", "source", "chat", "inbox"];

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_INBOX_BYTES = 1024 * 1024;
export const MAX_COMPOSER_FILES = 10;
export const MAX_DROP_FILES = 20;

export const TEXT_EXT = ["md", "txt", "csv", "json", "html"];
export const INBOX_FILE_EXT = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "csv",
  "txt",
  "md",
  "json",
];

export interface DroppedFile {
  name: string;
  size: number;
}

export function isTextFile(name: string): boolean {
  return TEXT_EXT.includes(extOf(name));
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
}

export type DropBlocker =
  | { reason: "offline" }
  | { reason: "unsupported" }
  | { reason: "tooMany"; max: number }
  | { reason: "tooLarge"; max: number };

export type InboxRoute = "text" | "file";

export function inboxRoute(file: DroppedFile): InboxRoute | DropBlocker {
  const ext = extOf(file.name);
  const asText = TEXT_EXT.includes(ext);
  const asFile = INBOX_FILE_EXT.includes(ext);
  if (asText && file.size <= MAX_INBOX_BYTES) return "text";
  if (asFile && file.size <= MAX_FILE_BYTES) return "file";
  if (asFile) return { reason: "tooLarge", max: MAX_FILE_BYTES };
  if (asText) return { reason: "tooLarge", max: MAX_INBOX_BYTES };
  return { reason: "unsupported" };
}

export function choiceBlocker(
  choice: DropChoice,
  files: readonly DroppedFile[],
  online: boolean,
): DropBlocker | null {
  if (!online) return { reason: "offline" };
  if (choice === "inbox") {
    for (const file of files) {
      const route = inboxRoute(file);
      if (typeof route !== "string") return route;
    }
    return null;
  }
  if (choice === "chat" && files.length > MAX_COMPOSER_FILES)
    return { reason: "tooMany", max: MAX_COMPOSER_FILES };
  const max = choice === "source" ? MAX_SOURCE_BYTES : MAX_FILE_BYTES;
  return files.some((file) => file.size > max) ? { reason: "tooLarge", max } : null;
}

export function placedHref(choice: DropChoice, ids: readonly string[]): string {
  if (choice === "chat") return "/chat";
  const list = choice === "file" ? "/files" : choice === "source" ? "/knowledge" : "/intake";
  const [only] = ids;
  return ids.length === 1 && only ? `${list}/${encodeURIComponent(only)}` : list;
}

export type DropPhase = "choosing" | "placing" | "failed";

export interface DropSheet {
  via: DropVia;
  files: DroppedFile[];
  phase: DropPhase;
  choice: DropChoice | null;
}

export type DropEvent =
  | { type: "place"; choice: DropChoice }
  | { type: "failed" }
  | { type: "add"; files: DroppedFile[]; via: DropVia };

export function openDrop(files: readonly DroppedFile[], via: DropVia): DropSheet | null {
  const kept = files.slice(0, MAX_DROP_FILES);
  return kept.length ? { via, files: kept, phase: "choosing", choice: null } : null;
}

export function reduceDrop(sheet: DropSheet, event: DropEvent): DropSheet {
  switch (event.type) {
    case "place":
      return sheet.phase === "placing"
        ? sheet
        : { ...sheet, phase: "placing", choice: event.choice };
    case "failed":
      return { ...sheet, phase: "failed" };
    case "add": {
      if (sheet.phase === "placing") return sheet;
      const known = new Set(sheet.files.map((file) => file.name));
      const files = [...sheet.files, ...event.files.filter((file) => !known.has(file.name))];
      return {
        via: event.via,
        files: files.slice(0, MAX_DROP_FILES),
        phase: "choosing",
        choice: null,
      };
    }
  }
}

export interface InboxFileNote {
  client_request_id: string;
  title: string;
  body: string;
  captured_at: string;
}

export function inboxFileNote(
  name: string,
  text: string,
  now: Date,
  requestId: string,
): InboxFileNote | null {
  const body = text.trim();
  if (!body) return null;
  return {
    client_request_id: requestId,
    title: baseName(name).slice(0, 200) || "file",
    body,
    captured_at: now.toISOString(),
  };
}

export function sourceName(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return (stem || base || "source").slice(0, 200);
}
