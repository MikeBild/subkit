import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/index.ts";
import { createIntakeItem, IntakeConflictError } from "../../knowledge/index.ts";
import {
  archiveNote,
  confirmNote,
  DEFAULT_EXPORT_LABELS,
  EXPORT_LABEL_MAX_CHARS,
  type ExportLabels,
  exportNotes,
  forgetNote,
  getNote,
  listNotes,
  MAX_NOTE_TEXT_CHARS,
  NOTE_AREAS,
  NOTE_FACT_KINDS,
  NOTE_ORIGINS,
  NOTE_STATUSES,
  type NoteDetail,
  type NoteFailure,
  type NoteOutcome,
  type NoteOwnerScope,
  type NoteSourceView,
  type NoteVersionView,
  type NoteView,
  noteOwner,
  recordNoteShared,
  restoreNote,
  updateNote,
} from "../../personal-notes/index.ts";
import { now } from "../../utils/index.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";
import { INTAKE_WRITE } from "./intake.ts";

const TAGS = ["identity"] as const;
export const PERSONAL_NOTES_PATH = "/v1/identity/me/notes";
const NOTE_PATH = `${PERSONAL_NOTES_PATH}/{id}`;

const NoteIdParam = z.object({ id: z.string().uuid() }).openapi("PersonalNoteIdParam");

const NoteStatusSchema = z
  .enum(NOTE_STATUSES)
  .describe(
    "mentioned_once: said once. learned: said in several conversations. confirmed: the person confirmed or wrote it.",
  );

const NoteFields = {
  id: z.string().uuid(),
  area: z.enum(NOTE_AREAS),
  slug: z.string(),
  origin: z
    .enum(NOTE_ORIGINS)
    .describe("stated: the person said it outright. inferred: concluded from what they wrote."),
  fact_kind: z.enum(NOTE_FACT_KINDS),
  text: z.string(),
  abstract: z.string().nullable(),
  status: NoteStatusSchema,
  confirmed_at: z.string().nullable(),
  version: z.number().int(),
  archived_at: z.string().nullable(),
  archive_reason: z
    .string()
    .nullable()
    .describe("Why the note is archived: superseded by a newer text, or manual."),
  source_count: z
    .number()
    .int()
    .describe("In how many different conversations the person said this."),
  created_at: z.string(),
  updated_at: z.string(),
};

const NoteSchema = z.object(NoteFields).openapi("PersonalNote");

const NoteSourceSchema = z
  .object({
    id: z.string().uuid(),
    quote: z.string().describe("The person's own words the note came from."),
    message_id: z.string().uuid().nullable(),
    conversation_id: z
      .string()
      .uuid()
      .nullable()
      .describe("The conversation the words were written in; null once it was deleted."),
    channel: z.string().nullable().describe("Where the conversation took place."),
    created_at: z.string(),
  })
  .openapi("PersonalNoteSource");

const NoteVersionSchema = z
  .object({ ...NoteFields, sources: z.array(NoteSourceSchema) })
  .openapi("PersonalNoteVersion");

const NoteDetailSchema = z
  .object({
    ...NoteFields,
    sources: z.array(NoteSourceSchema),
    earlier_versions: z
      .array(NoteVersionSchema)
      .describe("Texts this note replaced, nearest first, each with the reason it was archived."),
  })
  .openapi("PersonalNoteDetail");

const NoteListSchema = z
  .object({ notes: z.array(NoteSchema), total: z.number().int() })
  .openapi("PersonalNoteList");

const ListQuery = z
  .object({
    status: NoteStatusSchema.optional(),
    archived: z
      .enum(["true", "false"])
      .optional()
      .describe("true lists archived notes instead of the active ones."),
  })
  .openapi("PersonalNoteListQuery");

const UpdateBody = z
  .object({
    text: z.string().trim().min(1).max(MAX_NOTE_TEXT_CHARS),
    expected_version: z
      .number()
      .int()
      .min(1)
      .describe("The version the person was looking at; a newer one answers 409."),
  })
  .strict()
  .openapi("UpdatePersonalNoteBody");

const ShareBody = z
  .object({
    confirm: z
      .literal(true)
      .describe("The person's explicit yes to showing this note's text to the team."),
  })
  .strict()
  .openapi("SharePersonalNoteBody");

const ShareSchema = z
  .object({ intake_item_id: z.string().uuid(), category: z.string() })
  .openapi("PersonalNoteShared");

const ExportLabel = z.string().trim().min(1).max(EXPORT_LABEL_MAX_CHARS);

const ExportLabelsSchema = z
  .object({
    title: ExportLabel,
    empty: ExportLabel,
    quote: ExportLabel.describe("The words in front of each quote, such as: You wrote"),
    status: z
      .object({ confirmed: ExportLabel, learned: ExportLabel, mentioned_once: ExportLabel })
      .strict(),
    area: z
      .object({
        about: ExportLabel,
        preferences: ExportLabel,
        people: ExportLabel,
        routines: ExportLabel,
        lessons: ExportLabel,
      })
      .strict(),
  })
  .strict()
  .openapi("PersonalNotesExportLabels");

const ExportBody = z
  .object({
    labels: ExportLabelsSchema.optional().describe(
      "The headings of the export in the person's language. English when left out.",
    ),
  })
  .strict()
  .openapi("ExportPersonalNotesBody");

const ExportSchema = z
  .object({ markdown: z.string(), count: z.number().int() })
  .openapi("PersonalNotesExport");

const ForgottenSchema = z
  .object({ forgotten: z.number().int().describe("How many versions were deleted.") })
  .openapi("PersonalNoteForgotten");

const READ_ERRORS = {
  401: "Unauthorized",
  403: "person_required — personal notes belong to a signed-in person",
  404: "Not found",
} as const;

const WRITE_ERRORS = {
  ...READ_ERRORS,
  403: "person_required — personal notes belong to a signed-in person; human_confirmation_required — only the person in the browser changes their notes",
} as const;

function reader(scope: OperationScope): NoteOwnerScope | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  const owner = noteOwner(principal);
  if (!owner || principal.tenant_id !== scope.tenant_id)
    return reject.status(403, "person_required", "Personal notes belong to a signed-in person.");
  return { tenant_id: scope.tenant_id, user_id: owner.user_id };
}

function writer(scope: OperationScope): NoteOwnerScope | Rejection {
  const owner = reader(scope);
  if (isRejected(owner)) return owner;
  if (scope.principal?.auth_source?.kind !== "browser_session")
    return reject.status(
      403,
      "human_confirmation_required",
      "Only the person, signed in to the Cockpit, changes their notes.",
    );
  return owner;
}

function isRejected<T extends object>(value: T | Rejection): value is Rejection {
  return (value as Rejection).rejected === true;
}

const FAILURES: Record<NoteFailure, () => Rejection> = {
  not_found: () => reject.notFound("note"),
  version_conflict: () =>
    reject.conflict("The note changed in the meantime. Reload it.", undefined, "version_conflict"),
  address_taken: () =>
    reject.conflict(
      "A newer note on the same subject is active. Archive or forget that one first.",
      undefined,
      "address_taken",
    ),
  note_limit: () =>
    reject.conflict(
      "The limit of active notes is reached. Archive or forget one first.",
      undefined,
      "note_limit",
    ),
  secret_in_text: () =>
    reject.unprocessable(
      "The text looks like it contains a password, key or token. Notes never keep those.",
      undefined,
      "secret_in_text",
    ),
  invalid_text: () =>
    reject.unprocessable("The text is empty or too long.", undefined, "invalid_text"),
  not_archived: () => reject.conflict("The note is not archived.", undefined, "not_archived"),
  already_archived: () =>
    reject.conflict("The note is archived. Restore it first.", undefined, "already_archived"),
};

function settle<T>(outcome: NoteOutcome<T>): T | Rejection {
  return outcome.ok ? outcome.value : FAILURES[outcome.reason]();
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function noteBody(note: NoteView) {
  return {
    id: note.id,
    area: note.area,
    slug: note.slug,
    origin: note.origin,
    fact_kind: note.fact_kind,
    text: note.text,
    abstract: note.abstract,
    status: note.status,
    confirmed_at: iso(note.confirmed_at),
    version: note.version,
    archived_at: iso(note.archived_at),
    archive_reason: note.archive_reason,
    source_count: note.source_count,
    created_at: note.created_at.toISOString(),
    updated_at: note.updated_at.toISOString(),
  };
}

function sourceBody(source: NoteSourceView) {
  return {
    id: source.id,
    quote: source.quote,
    message_id: source.message_id,
    conversation_id: source.conversation_id,
    channel: source.channel,
    created_at: source.created_at.toISOString(),
  };
}

function versionBody(version: NoteVersionView) {
  return { ...noteBody(version), sources: version.sources.map(sourceBody) };
}

function detailBody(detail: NoteDetail) {
  return { ...versionBody(detail), earlier_versions: detail.earlier_versions.map(versionBody) };
}

type ListInput = { status?: NoteView["status"] | undefined; archived: boolean };

export const listPersonalNotesOperation = defineOperation<ListInput, NoteView[]>({
  id: "identity.me.notes.list",
  summary: "List the signed-in person's own personal notes",
  permission: null,
  effect: "read",
  async handler(scope, input) {
    const owner = reader(scope);
    if (isRejected(owner)) return owner;
    return listNotes(scope.db, owner, input);
  },
  http: {
    method: "get",
    path: PERSONAL_NOTES_PATH,
    tags: TAGS,
    description:
      "Personal notes are private: only the person they belong to reads them. No other member and no administrator can, and no request names another person. API keys, exchanged tokens and system accounts have no notes.",
    query: ListQuery,
    response: NoteListSchema,
    errors: READ_ERRORS,
    toInput: ({ query }) => {
      const q = query as z.infer<typeof ListQuery>;
      return { status: q.status, archived: q.archived === "true" };
    },
    toBody: (notes) => ({ notes: notes.map(noteBody), total: notes.length }),
  },
});

export const getPersonalNoteOperation = defineOperation<string, NoteDetail>({
  id: "identity.me.notes.get",
  summary: "Read one of the person's own notes with its sources and earlier versions",
  permission: null,
  effect: "read",
  async handler(scope, id) {
    const owner = reader(scope);
    if (isRejected(owner)) return owner;
    return (await getNote(scope.db, owner, id)) ?? reject.notFound("note");
  },
  http: {
    method: "get",
    path: NOTE_PATH,
    tags: TAGS,
    description: "A note of another person answers 404, for administrators too.",
    params: NoteIdParam,
    response: NoteDetailSchema,
    errors: READ_ERRORS,
    toInput: ({ param }) => (param as z.infer<typeof NoteIdParam>).id,
    toBody: detailBody,
  },
});

type UpdateInput = { id: string } & z.infer<typeof UpdateBody>;

export const updatePersonalNoteOperation = defineOperation<UpdateInput, NoteView>({
  id: "identity.me.notes.update",
  summary: "Rewrite one of the person's own notes; the old text stays as an earlier version",
  permission: null,
  effect: "write",
  audit: AuditAction.PERSONAL_NOTE_UPDATED,
  async handler(scope, input) {
    const owner = writer(scope);
    if (isRejected(owner)) return owner;
    return settle(await updateNote(scope.db, owner, input.id, input, new Date(now())));
  },
  http: {
    method: "put",
    path: NOTE_PATH,
    tags: TAGS,
    description:
      "The new text becomes a confirmed note under a new id; the old one is archived as superseded and listed under earlier_versions.",
    params: NoteIdParam,
    body: UpdateBody,
    response: NoteSchema,
    errors: {
      ...WRITE_ERRORS,
      409: "version_conflict — the note changed in the meantime; already_archived",
      422: "secret_in_text — the text looks like a password, key or token",
    },
    toInput: ({ param, json }) => ({
      id: (param as z.infer<typeof NoteIdParam>).id,
      ...(json as z.infer<typeof UpdateBody>),
    }),
    toBody: noteBody,
  },
});

export const confirmPersonalNoteOperation = defineOperation<string, NoteView>({
  id: "identity.me.notes.confirm",
  summary: "Confirm one of the person's own notes as correct",
  permission: null,
  effect: "write",
  audit: AuditAction.PERSONAL_NOTE_CONFIRMED,
  async handler(scope, id) {
    const owner = writer(scope);
    if (isRejected(owner)) return owner;
    return settle(await confirmNote(scope.db, owner, id, new Date(now())));
  },
  http: {
    method: "post",
    path: `${NOTE_PATH}/confirm`,
    tags: TAGS,
    params: NoteIdParam,
    response: NoteSchema,
    errors: { ...WRITE_ERRORS, 409: "already_archived — restore the note first" },
    toInput: ({ param }) => (param as z.infer<typeof NoteIdParam>).id,
    toBody: noteBody,
  },
});

export const archivePersonalNoteOperation = defineOperation<string, NoteView>({
  id: "identity.me.notes.archive",
  summary: "Archive one of the person's own notes; it is no longer used in answers",
  permission: null,
  effect: "write",
  audit: AuditAction.PERSONAL_NOTE_ARCHIVED,
  async handler(scope, id) {
    const owner = writer(scope);
    if (isRejected(owner)) return owner;
    return settle(await archiveNote(scope.db, owner, id, new Date(now())));
  },
  http: {
    method: "post",
    path: `${NOTE_PATH}/archive`,
    tags: TAGS,
    params: NoteIdParam,
    response: NoteSchema,
    errors: { ...WRITE_ERRORS, 409: "already_archived" },
    toInput: ({ param }) => (param as z.infer<typeof NoteIdParam>).id,
    toBody: noteBody,
  },
});

export const restorePersonalNoteOperation = defineOperation<string, NoteView>({
  id: "identity.me.notes.restore",
  summary: "Restore an archived note of the person",
  permission: null,
  effect: "write",
  audit: AuditAction.PERSONAL_NOTE_RESTORED,
  async handler(scope, id) {
    const owner = writer(scope);
    if (isRejected(owner)) return owner;
    return settle(await restoreNote(scope.db, owner, id, new Date(now())));
  },
  http: {
    method: "post",
    path: `${NOTE_PATH}/restore`,
    tags: TAGS,
    params: NoteIdParam,
    response: NoteSchema,
    errors: {
      ...WRITE_ERRORS,
      409: "not_archived; address_taken — a newer note on the same subject is active; note_limit",
    },
    toInput: ({ param }) => (param as z.infer<typeof NoteIdParam>).id,
    toBody: noteBody,
  },
});

export const forgetPersonalNoteOperation = defineOperation<string, { forgotten: number }>({
  id: "identity.me.notes.forget",
  summary: "Delete one of the person's own notes for good, with all its earlier versions",
  permission: null,
  effect: "write",
  audit: AuditAction.PERSONAL_NOTE_FORGOTTEN,
  async handler(scope, id) {
    const owner = writer(scope);
    if (isRejected(owner)) return owner;
    return settle(await forgetNote(scope.db, owner, id));
  },
  http: {
    method: "delete",
    path: NOTE_PATH,
    tags: TAGS,
    description:
      "Deletes the note, the texts it replaced and every stored quote. This cannot be undone. The audit log keeps only that a note was forgotten, never its text.",
    params: NoteIdParam,
    response: ForgottenSchema,
    errors: WRITE_ERRORS,
    toInput: ({ param }) => (param as z.infer<typeof NoteIdParam>).id,
    toBody: (result) => result,
  },
});

function sharedBody(note: NoteDetail): string {
  const quotes = note.sources.map((source) => `> ${source.quote.replace(/\s+/gu, " ").trim()}`);
  return quotes.length > 0 ? `${note.text}\n\n${quotes.join("\n")}` : note.text;
}

export const sharePersonalNoteOperation = defineOperation<
  string,
  { intake_item_id: string; category: string }
>({
  id: "identity.me.notes.share",
  summary: "Share one of the person's own notes with the team as an intake item",
  permission: null,
  effect: "write",
  audit: AuditAction.PERSONAL_NOTE_SHARED,
  async handler(scope, id) {
    const owner = writer(scope);
    if (isRejected(owner)) return owner;
    const ensurePermission = scope.ensurePermission;
    if (!ensurePermission) return reject.unauthorized();
    await ensurePermission(INTAKE_WRITE);
    const note = await getNote(scope.db, owner, id);
    if (!note) return reject.notFound("note");
    if (note.archived_at) return FAILURES.already_archived();
    try {
      const item = await createIntakeItem(
        {
          tenant_id: scope.tenant_id,
          actor: { kind: "user", id: owner.user_id },
          client_request_id: note.id,
          title: note.abstract ?? note.text.slice(0, 120),
          captured_at: note.created_at.toISOString(),
          body: sharedBody(note),
        },
        scope.db,
      );
      await recordNoteShared(scope.db, owner, note);
      return { intake_item_id: item.id, category: item.category };
    } catch (error) {
      if (error instanceof IntakeConflictError)
        return reject.conflict(error.message, undefined, "already_shared");
      throw error;
    }
  },
  http: {
    method: "post",
    path: `${NOTE_PATH}/share`,
    tags: TAGS,
    description:
      "Copies the note's text and the person's quotes into the team's intake, where a person reviews it before it becomes knowledge. The note itself stays private. Needs the person's explicit confirmation and intake:write. Sharing the same note twice returns the same item.",
    params: NoteIdParam,
    body: ShareBody,
    response: ShareSchema,
    success: { status: 201, description: "Created" },
    errors: { ...WRITE_ERRORS, 409: "already_archived; already_shared" },
    toInput: ({ param }) => (param as z.infer<typeof NoteIdParam>).id,
    toBody: (result) => result,
  },
});

export const exportPersonalNotesOperation = defineOperation<
  ExportLabels,
  { markdown: string; count: number }
>({
  id: "identity.me.notes.export",
  summary: "Export the person's own active notes as Markdown, with the quotes they came from",
  permission: null,
  effect: "write",
  audit: AuditAction.PERSONAL_NOTE_EXPORTED,
  async handler(scope, labels) {
    const owner = writer(scope);
    if (isRejected(owner)) return owner;
    return exportNotes(scope.db, owner, labels);
  },
  http: {
    method: "post",
    path: `${PERSONAL_NOTES_PATH}/export`,
    tags: TAGS,
    description:
      "Grouped by status and area. The export is recorded in the audit log without any note text.",
    body: ExportBody,
    response: ExportSchema,
    errors: WRITE_ERRORS,
    toInput: ({ json }) => (json as z.infer<typeof ExportBody>).labels ?? DEFAULT_EXPORT_LABELS,
    toBody: (result) => result,
  },
});
