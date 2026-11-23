import { ApiError } from "@/api/transport";
import { conversationHref, conversationMessageHref } from "@/app/links";
import type {
  NoteArea,
  NoteStatus,
  NotesExportLabels,
  PersonalNote,
  PersonalNoteSource,
} from "@/features/notes/api/notes-api";
import type { NotesKey, NotesText } from "./notes-copy";

export const NOTES_PATH: string = "/notes";
export const NOTE_TEXT_MAX = 600;

export function noteHref(id: string): string {
  return `${NOTES_PATH}/${encodeURIComponent(id)}`;
}

export const NOTE_STATUS_ORDER: readonly NoteStatus[] = ["confirmed", "learned", "mentioned_once"];

const AREA_ORDER: readonly NoteArea[] = ["about", "preferences", "people", "routines", "lessons"];

export const NOTE_STATUS_LABEL: Record<NoteStatus, NotesKey> = {
  confirmed: "notes.status.confirmed",
  learned: "notes.status.learned",
  mentioned_once: "notes.status.mentioned_once",
};

export const NOTE_STATUS_HINT: Record<NoteStatus, NotesKey> = {
  confirmed: "notes.status.confirmed.hint",
  learned: "notes.status.learned.hint",
  mentioned_once: "notes.status.mentioned_once.hint",
};

export const NOTE_STATUS_TONE: Record<NoteStatus, "success" | "info" | "neutral"> = {
  confirmed: "success",
  learned: "info",
  mentioned_once: "neutral",
};

export const NOTE_AREA_LABEL: Record<NoteArea, NotesKey> = {
  about: "notes.area.about",
  preferences: "notes.area.preferences",
  people: "notes.area.people",
  routines: "notes.area.routines",
  lessons: "notes.area.lessons",
};

export const NOTE_ORIGIN_LABEL: Record<PersonalNote["origin"], NotesKey> = {
  stated: "notes.origin.stated",
  inferred: "notes.origin.inferred",
};

export const NOTE_KIND_LABEL: Record<PersonalNote["fact_kind"], NotesKey> = {
  fact: "notes.kind.fact",
  preference: "notes.kind.preference",
  plan: "notes.kind.plan",
  event: "notes.kind.event",
};

export function exportLabels(nt: NotesText): NotesExportLabels {
  return {
    title: nt("notes.export.heading"),
    empty: nt("notes.export.empty"),
    quote: nt("notes.sheet.quote"),
    status: {
      confirmed: nt(NOTE_STATUS_LABEL.confirmed),
      learned: nt(NOTE_STATUS_LABEL.learned),
      mentioned_once: nt(NOTE_STATUS_LABEL.mentioned_once),
    },
    area: {
      about: nt(NOTE_AREA_LABEL.about),
      preferences: nt(NOTE_AREA_LABEL.preferences),
      people: nt(NOTE_AREA_LABEL.people),
      routines: nt(NOTE_AREA_LABEL.routines),
      lessons: nt(NOTE_AREA_LABEL.lessons),
    },
  };
}

export interface NoteGroup {
  status: NoteStatus;
  notes: PersonalNote[];
}

export function groupByStatus(notes: readonly PersonalNote[]): NoteGroup[] {
  return NOTE_STATUS_ORDER.map((status) => ({
    status,
    notes: notes
      .filter((note) => note.status === status)
      .sort(
        (a, b) =>
          AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) ||
          b.updated_at.localeCompare(a.updated_at) ||
          a.id.localeCompare(b.id),
      ),
  })).filter((group) => group.notes.length > 0);
}

export function noteTitle(note: Pick<PersonalNote, "abstract" | "text">): string {
  return note.abstract?.trim() || note.text;
}

export function sourcesLabel(count: number): { key: NotesKey; count: number } {
  if (count <= 0) return { key: "notes.sources.none", count: 0 };
  return { key: count === 1 ? "notes.sources.one" : "notes.sources.other", count };
}

const CHANNEL_KEYS: Record<string, NotesKey> = {
  web: "notes.channel.web",
  chat: "notes.channel.chat",
  mcp: "notes.channel.mcp",
  sk_headless: "notes.channel.sk_headless",
  sk_interactive: "notes.channel.sk_interactive",
};

export function channelKey(channel: string | null): NotesKey {
  return (channel && CHANNEL_KEYS[channel]) || "notes.channel.unknown";
}

export function reasonKey(reason: string | null): NotesKey {
  if (reason === "superseded") return "notes.reason.superseded";
  if (reason === "manual") return "notes.reason.manual";
  return "notes.reason.other";
}

export function sourceHref(
  source: Pick<PersonalNoteSource, "conversation_id" | "message_id">,
): string | null {
  if (!source.conversation_id) return null;
  return source.message_id
    ? conversationMessageHref(source.conversation_id, source.message_id)
    : conversationHref(source.conversation_id);
}

export type NoteAction = "confirm" | "edit" | "share" | "archive" | "restore" | "forget";

export function noteActions(
  note: Pick<PersonalNote, "archived_at" | "confirmed_at">,
  canShare: boolean,
): NoteAction[] {
  if (note.archived_at) return ["restore", "forget"];
  return [
    ...(note.confirmed_at ? [] : (["confirm"] as const)),
    "edit",
    ...(canShare ? (["share"] as const) : []),
    "archive",
    "forget",
  ];
}

export function editProblem(text: string): { key: NotesKey; max?: number } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { key: "notes.edit.empty" };
  if (trimmed.length > NOTE_TEXT_MAX) return { key: "notes.edit.tooLong", max: NOTE_TEXT_MAX };
  return null;
}

const ERROR_KEYS: Record<string, NotesKey> = {
  version_conflict: "notes.error.versionConflict",
  address_taken: "notes.error.addressTaken",
  note_limit: "notes.error.noteLimit",
  secret_in_text: "notes.error.secretInText",
  not_found: "notes.error.notFound",
  human_confirmation_required: "notes.error.signedInOnly",
  person_required: "notes.error.signedInOnly",
  permission_denied: "notes.error.shareNotAllowed",
  forbidden: "notes.error.shareNotAllowed",
};

export function noteErrorKey(error: unknown): NotesKey {
  if (!(error instanceof ApiError)) return "notes.error.generic";
  if (error.code && ERROR_KEYS[error.code]) return ERROR_KEYS[error.code] as NotesKey;
  return error.status === 404 ? "notes.error.notFound" : "notes.error.generic";
}

export function isGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
