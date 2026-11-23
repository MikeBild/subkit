import { apiRequest } from "@/api/transport";

export type NoteStatus = "mentioned_once" | "learned" | "confirmed";
export type NoteArea = "about" | "preferences" | "people" | "routines" | "lessons";

export interface PersonalNote {
  id: string;
  area: NoteArea;
  slug: string;
  origin: "stated" | "inferred";
  fact_kind: "fact" | "preference" | "plan" | "event";
  text: string;
  abstract: string | null;
  status: NoteStatus;
  confirmed_at: string | null;
  version: number;
  archived_at: string | null;
  archive_reason: string | null;
  source_count: number;
  created_at: string;
  updated_at: string;
}

export interface PersonalNoteSource {
  id: string;
  quote: string;
  message_id: string | null;
  conversation_id: string | null;
  channel: string | null;
  created_at: string;
}

export interface PersonalNoteVersion extends PersonalNote {
  sources: PersonalNoteSource[];
}

export interface PersonalNoteDetail extends PersonalNoteVersion {
  earlier_versions: PersonalNoteVersion[];
}

const BASE = "/v1/identity/me/notes";

export const NOTES_KEY = ["personal-notes"] as const;

export function notesListKey(archived: boolean) {
  return [...NOTES_KEY, "list", archived ? "archived" : "active"] as const;
}

export function noteKey(id: string) {
  return [...NOTES_KEY, "note", id] as const;
}

function notePath(id: string, action?: string): string {
  return `${BASE}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function listNotes(archived: boolean): Promise<PersonalNote[]> {
  const result = await apiRequest<{ notes: PersonalNote[] }>(
    archived ? `${BASE}?archived=true` : BASE,
  );
  return result.notes;
}

export function readNote(id: string): Promise<PersonalNoteDetail> {
  return apiRequest<PersonalNoteDetail>(notePath(id));
}

export function updateNote(
  id: string,
  body: { text: string; expected_version: number },
): Promise<PersonalNote> {
  return apiRequest<PersonalNote>(notePath(id), { method: "PUT", body: JSON.stringify(body) });
}

export function confirmNote(id: string): Promise<PersonalNote> {
  return post(notePath(id, "confirm"));
}

export function archiveNote(id: string): Promise<PersonalNote> {
  return post(notePath(id, "archive"));
}

export function restoreNote(id: string): Promise<PersonalNote> {
  return post(notePath(id, "restore"));
}

export function forgetNote(id: string): Promise<{ forgotten: number }> {
  return apiRequest(notePath(id), { method: "DELETE" });
}

export function shareNote(id: string): Promise<{ intake_item_id: string; category: string }> {
  return post(notePath(id, "share"), { confirm: true });
}

export interface NotesExportLabels {
  title: string;
  empty: string;
  quote: string;
  status: Record<NoteStatus, string>;
  area: Record<NoteArea, string>;
}

export function exportNotes(
  labels: NotesExportLabels,
): Promise<{ markdown: string; count: number }> {
  return post(`${BASE}/export`, { labels });
}
