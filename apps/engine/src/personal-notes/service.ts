import { AuditAction, type AuditActionValue, auditAwait } from "../audit/index.ts";
import type { Db, Executor } from "../db/index.ts";
import { findSecretSpans } from "../logging/index.ts";
import {
  type ExistingNote,
  MAX_ACTIVE_NOTES,
  MAX_NOTE_ABSTRACT_CHARS,
  MAX_NOTE_TEXT_CHARS,
  type NoteArea,
  type NoteFactKind,
  type NoteOrigin,
  type NoteSource,
  type NoteWrite,
} from "./core/apply-proposals.ts";
import { type ExportLabels, exportMarkdown } from "./core/export-markdown.ts";
import { earlierVersions, forgetChain } from "./core/forget-chain.ts";
import { type NoteHit, rankNotes } from "./core/search.ts";
import { distinctSourceCount, type NoteStatus, noteStatus } from "./core/status.ts";
import {
  archiveNoteRow,
  confirmNoteRow,
  countActiveNotes,
  deleteNoteRows,
  findActiveByAddress,
  findNoteRow,
  insertNoteRow,
  insertSourceRow,
  linkReplacement,
  listNoteRows,
  listSourceRows,
  lockOwner,
  type NoteRow,
  type NoteSourceWithChannel,
  restoreNoteRow,
  touchActiveNote,
} from "./persistence/notes.ts";
import { type NoteOwnerScope, openField, sealField } from "./sealing.ts";

export interface NoteSourceView {
  readonly id: string;
  readonly quote: string;
  readonly message_id: string | null;
  readonly conversation_id: string | null;
  readonly channel: string | null;
  readonly created_at: Date;
}

export interface NoteView {
  readonly id: string;
  readonly area: NoteArea;
  readonly slug: string;
  readonly origin: NoteOrigin;
  readonly fact_kind: NoteFactKind;
  readonly text: string;
  readonly abstract: string | null;
  readonly status: NoteStatus;
  readonly confirmed_at: Date | null;
  readonly version: number;
  readonly archived_at: Date | null;
  readonly archive_reason: string | null;
  readonly source_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NoteVersionView extends NoteView {
  readonly sources: NoteSourceView[];
}

export interface NoteDetail extends NoteVersionView {
  readonly earlier_versions: NoteVersionView[];
}

export type NoteFailure =
  | "not_found"
  | "version_conflict"
  | "address_taken"
  | "note_limit"
  | "secret_in_text"
  | "invalid_text"
  | "not_archived"
  | "already_archived";

export type NoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: NoteFailure };

export type NoteActor = "person" | "learning";

function fail(reason: NoteFailure): { ok: false; reason: NoteFailure } {
  return { ok: false, reason };
}

function sourcesByNote(
  sources: readonly NoteSourceWithChannel[],
): Map<string, NoteSourceWithChannel[]> {
  const out = new Map<string, NoteSourceWithChannel[]>();
  for (const source of sources) {
    const list = out.get(source.note_id) ?? [];
    list.push(source);
    out.set(source.note_id, list);
  }
  return out;
}

function openNote(
  owner: NoteOwnerScope,
  row: NoteRow,
  sources: readonly NoteSourceWithChannel[],
): NoteView {
  const source_count = distinctSourceCount(sources);
  return {
    id: row.id,
    area: row.area,
    slug: row.slug,
    origin: row.origin,
    fact_kind: row.fact_kind,
    text: openField(owner, row.id, "text", {
      ciphertext: row.text_ciphertext,
      iv: row.text_iv,
      auth_tag: row.text_auth_tag,
    }),
    abstract:
      row.abstract_ciphertext && row.abstract_iv && row.abstract_auth_tag
        ? openField(owner, row.id, "abstract", {
            ciphertext: row.abstract_ciphertext,
            iv: row.abstract_iv,
            auth_tag: row.abstract_auth_tag,
          })
        : null,
    status: noteStatus({
      confirmed_at: row.confirmed_at,
      origin: row.origin,
      distinct_source_count: source_count,
    }),
    confirmed_at: row.confirmed_at,
    version: row.version,
    archived_at: row.archived_at,
    archive_reason: row.archive_reason,
    source_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function openSource(owner: NoteOwnerScope, source: NoteSourceWithChannel): NoteSourceView {
  return {
    id: source.id,
    quote: openField(owner, source.note_id, "quote", {
      ciphertext: source.quote_ciphertext,
      iv: source.quote_iv,
      auth_tag: source.quote_auth_tag,
    }),
    message_id: source.message_id,
    conversation_id: source.conversation_id,
    channel: source.channel,
    created_at: source.created_at,
  };
}

function openVersion(
  owner: NoteOwnerScope,
  row: NoteRow,
  sources: readonly NoteSourceWithChannel[],
): NoteVersionView {
  return {
    ...openNote(owner, row, sources),
    sources: sources.map((source) => openSource(owner, source)),
  };
}

async function auditNote(
  db: Executor,
  owner: NoteOwnerScope,
  action: AuditActionValue,
  actor: NoteActor,
  note: { id: string | null; area: string | null; origin: string | null },
  facts: { source_count: number; bytes: number },
): Promise<void> {
  await auditAwait(
    {
      tenant_id: owner.tenant_id,
      actor_type: actor === "person" ? "user" : "system",
      actor_id: actor === "person" ? owner.user_id : null,
      action,
      resource_type: "personal_note",
      resource_id: note.id,
      result: "success",
      metadata: {
        area: note.area,
        origin: note.origin,
        source_count: facts.source_count,
        bytes: facts.bytes,
      },
    },
    db,
  );
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export async function listNotes(
  db: Executor,
  owner: NoteOwnerScope,
  filter: { status?: NoteStatus | undefined; archived?: boolean | undefined } = {},
): Promise<NoteView[]> {
  const rows = await listNoteRows(db, owner, filter.archived ? "archived" : "active");
  const sources = sourcesByNote(
    await listSourceRows(
      db,
      owner,
      rows.map((row) => row.id),
    ),
  );
  const notes = rows.map((row) => openNote(owner, row, sources.get(row.id) ?? []));
  return filter.status ? notes.filter((note) => note.status === filter.status) : notes;
}

export async function getNote(
  db: Executor,
  owner: NoteOwnerScope,
  id: string,
): Promise<NoteDetail | null> {
  const row = await findNoteRow(db, owner, id);
  if (!row) return null;
  const all = await listNoteRows(db, owner, "all");
  const earlier = earlierVersions(all, id);
  const sources = sourcesByNote(await listSourceRows(db, owner, [id, ...earlier.map((v) => v.id)]));
  return {
    ...openVersion(owner, row, sources.get(row.id) ?? []),
    earlier_versions: earlier.map((version) =>
      openVersion(owner, version, sources.get(version.id) ?? []),
    ),
  };
}

interface NewNote {
  readonly area: NoteArea;
  readonly slug: string;
  readonly origin: NoteOrigin;
  readonly fact_kind: NoteFactKind;
  readonly text: string;
  readonly abstract: string;
  readonly confirmed: boolean;
  readonly version: number;
}

async function insertNote(
  db: Executor,
  owner: NoteOwnerScope,
  note: NewNote,
  at: Date,
): Promise<NoteRow> {
  const id = crypto.randomUUID();
  const text = sealField(owner, id, "text", note.text);
  const abstract = sealField(owner, id, "abstract", note.abstract);
  return insertNoteRow(db, {
    id,
    tenant_id: owner.tenant_id,
    user_id: owner.user_id,
    area: note.area,
    slug: note.slug,
    origin: note.origin,
    fact_kind: note.fact_kind,
    text_ciphertext: text.ciphertext,
    text_iv: text.iv,
    text_auth_tag: text.auth_tag,
    abstract_ciphertext: abstract.ciphertext,
    abstract_iv: abstract.iv,
    abstract_auth_tag: abstract.auth_tag,
    confirmed_at: note.confirmed ? at : null,
    version: note.version,
    created_at: at,
    updated_at: at,
  });
}

async function insertSource(
  db: Executor,
  owner: NoteOwnerScope,
  note_id: string,
  source: NoteSource,
  at: Date,
): Promise<boolean> {
  const quote = sealField(owner, note_id, "quote", source.quote);
  return insertSourceRow(db, {
    tenant_id: owner.tenant_id,
    note_id,
    message_id: source.message_id,
    conversation_id: source.conversation_id,
    quote_ciphertext: quote.ciphertext,
    quote_iv: quote.iv,
    quote_auth_tag: quote.auth_tag,
    created_at: at,
  });
}

async function applyWrite(
  tx: Executor,
  owner: NoteOwnerScope,
  write: NoteWrite,
  actor: NoteActor,
  at: Date,
): Promise<boolean> {
  await lockOwner(tx, owner);
  if (write.kind === "create") {
    if (await findActiveByAddress(tx, owner, write.area, write.slug)) return false;
    if ((await countActiveNotes(tx, owner)) >= MAX_ACTIVE_NOTES) return false;
    const row = await insertNote(tx, owner, { ...write, version: 1 }, at);
    await insertSource(tx, owner, row.id, write.source, at);
    await auditNote(tx, owner, AuditAction.PERSONAL_NOTE_CREATED, actor, row, {
      source_count: 1,
      bytes: bytesOf(write.text),
    });
    return true;
  }
  if (write.kind === "add_source") {
    const cas = { id: write.note_id, expected_version: write.expected_version, at };
    const row = await findNoteRow(tx, owner, write.note_id);
    if (!row || !(await touchActiveNote(tx, owner, cas))) return false;
    if (!(await insertSource(tx, owner, write.note_id, write.source, at))) return false;
    const confirming = write.confirm && !row.confirmed_at;
    if (confirming) await confirmNoteRow(tx, owner, cas);
    const sources = await listSourceRows(tx, owner, [row.id]);
    await auditNote(
      tx,
      owner,
      confirming ? AuditAction.PERSONAL_NOTE_CONFIRMED : AuditAction.PERSONAL_NOTE_UPDATED,
      actor,
      row,
      { source_count: distinctSourceCount(sources), bytes: 0 },
    );
    return true;
  }
  const archived = await archiveNoteRow(tx, owner, {
    id: write.note_id,
    expected_version: write.expected_version,
    reason: "superseded",
    at,
  });
  if (!archived) return false;
  const row = await insertNote(tx, owner, { ...write, version: write.expected_version + 1 }, at);
  await linkReplacement(tx, owner, write.note_id, row.id);
  await insertSource(tx, owner, row.id, write.source, at);
  await auditNote(tx, owner, AuditAction.PERSONAL_NOTE_UPDATED, actor, row, {
    source_count: 1,
    bytes: bytesOf(write.text),
  });
  return true;
}

export async function applyNoteWrites(
  db: Db,
  owner: NoteOwnerScope,
  writes: readonly NoteWrite[],
  actor: NoteActor,
  at: Date,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  for (const write of writes) {
    const done = await db.transaction((tx) => applyWrite(tx, owner, write, actor, at));
    if (done) applied += 1;
  }
  return { applied, skipped: writes.length - applied };
}

export async function existingNotesOf(
  db: Executor,
  owner: NoteOwnerScope,
): Promise<ExistingNote[]> {
  const rows = await listNoteRows(db, owner, "active");
  const sources = sourcesByNote(
    await listSourceRows(
      db,
      owner,
      rows.map((row) => row.id),
    ),
  );
  return rows.map((row) => {
    const note = openNote(owner, row, sources.get(row.id) ?? []);
    return {
      id: note.id,
      area: note.area,
      slug: note.slug,
      text: note.text,
      confirmed: note.confirmed_at !== null,
      version: note.version,
      source_message_ids: (sources.get(row.id) ?? []).flatMap((source) =>
        source.message_id ? [source.message_id] : [],
      ),
    };
  });
}

function clipAbstract(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= MAX_NOTE_ABSTRACT_CHARS
    ? flat
    : flat.slice(0, MAX_NOTE_ABSTRACT_CHARS).trimEnd();
}

export async function updateNote(
  db: Db,
  owner: NoteOwnerScope,
  id: string,
  input: { text: string; expected_version: number },
  at: Date,
): Promise<NoteOutcome<NoteView>> {
  const text = input.text.trim();
  if (text.length === 0 || text.length > MAX_NOTE_TEXT_CHARS) return fail("invalid_text");
  if (findSecretSpans(text).length > 0) return fail("secret_in_text");
  return db.transaction(async (tx) => {
    await lockOwner(tx, owner);
    const before = await findNoteRow(tx, owner, id, true);
    if (!before) return fail("not_found");
    if (before.archived_at) return fail("already_archived");
    const archived = await archiveNoteRow(tx, owner, {
      id,
      expected_version: input.expected_version,
      reason: "superseded",
      at,
    });
    if (!archived) return fail("version_conflict");
    const row = await insertNote(
      tx,
      owner,
      {
        area: before.area,
        slug: before.slug,
        origin: "stated",
        fact_kind: before.fact_kind,
        text,
        abstract: clipAbstract(text),
        confirmed: true,
        version: before.version + 1,
      },
      at,
    );
    await linkReplacement(tx, owner, id, row.id);
    await auditNote(tx, owner, AuditAction.PERSONAL_NOTE_UPDATED, "person", row, {
      source_count: 0,
      bytes: bytesOf(text),
    });
    return { ok: true as const, value: openNote(owner, row, []) };
  });
}

async function changed(
  tx: Executor,
  owner: NoteOwnerScope,
  id: string,
  action: AuditActionValue,
): Promise<NoteOutcome<NoteView>> {
  const row = await findNoteRow(tx, owner, id);
  if (!row) return fail("not_found");
  const sources = await listSourceRows(tx, owner, [id]);
  const view = openNote(owner, row, sources);
  await auditNote(tx, owner, action, "person", row, {
    source_count: view.source_count,
    bytes: bytesOf(view.text),
  });
  return { ok: true, value: view };
}

export async function confirmNote(
  db: Db,
  owner: NoteOwnerScope,
  id: string,
  at: Date,
): Promise<NoteOutcome<NoteView>> {
  return db.transaction(async (tx) => {
    const row = await findNoteRow(tx, owner, id, true);
    if (!row) return fail("not_found");
    if (row.archived_at) return fail("already_archived");
    if (row.confirmed_at)
      return {
        ok: true as const,
        value: openNote(owner, row, await listSourceRows(tx, owner, [id])),
      };
    await confirmNoteRow(tx, owner, { id, expected_version: row.version, at });
    return changed(tx, owner, id, AuditAction.PERSONAL_NOTE_CONFIRMED);
  });
}

export async function archiveNote(
  db: Db,
  owner: NoteOwnerScope,
  id: string,
  at: Date,
): Promise<NoteOutcome<NoteView>> {
  return db.transaction(async (tx) => {
    const row = await findNoteRow(tx, owner, id, true);
    if (!row) return fail("not_found");
    if (row.archived_at) return fail("already_archived");
    await archiveNoteRow(tx, owner, {
      id,
      expected_version: row.version,
      reason: "manual",
      at,
    });
    return changed(tx, owner, id, AuditAction.PERSONAL_NOTE_ARCHIVED);
  });
}

export async function restoreNote(
  db: Db,
  owner: NoteOwnerScope,
  id: string,
  at: Date,
): Promise<NoteOutcome<NoteView>> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, owner);
    const row = await findNoteRow(tx, owner, id, true);
    if (!row) return fail("not_found");
    if (!row.archived_at) return fail("not_archived");
    if (await findActiveByAddress(tx, owner, row.area, row.slug)) return fail("address_taken");
    if ((await countActiveNotes(tx, owner)) >= MAX_ACTIVE_NOTES) return fail("note_limit");
    await restoreNoteRow(tx, owner, id, at);
    return changed(tx, owner, id, AuditAction.PERSONAL_NOTE_RESTORED);
  });
}

export async function forgetNote(
  db: Db,
  owner: NoteOwnerScope,
  id: string,
): Promise<NoteOutcome<{ forgotten: number }>> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, owner);
    const row = await findNoteRow(tx, owner, id, true);
    if (!row) return fail("not_found");
    const chain = forgetChain(await listNoteRows(tx, owner, "all"), id);
    const sources = await listSourceRows(tx, owner, chain);
    const forgotten = await deleteNoteRows(tx, owner, chain);
    await auditNote(tx, owner, AuditAction.PERSONAL_NOTE_FORGOTTEN, "person", row, {
      source_count: distinctSourceCount(sources),
      bytes: 0,
    });
    return { ok: true as const, value: { forgotten } };
  });
}

export async function exportNotes(
  db: Db,
  owner: NoteOwnerScope,
  labels: ExportLabels,
): Promise<{ markdown: string; count: number }> {
  const rows = await listNoteRows(db, owner, "active");
  const sources = sourcesByNote(
    await listSourceRows(
      db,
      owner,
      rows.map((row) => row.id),
    ),
  );
  const notes = rows.map((row) => openVersion(owner, row, sources.get(row.id) ?? []));
  const markdown = exportMarkdown(
    notes.map((note) => ({
      area: note.area,
      status: note.status,
      text: note.text,
      quotes: note.sources.map((source) => source.quote),
    })),
    labels,
  );
  await auditNote(
    db,
    owner,
    AuditAction.PERSONAL_NOTE_EXPORTED,
    "person",
    { id: null, area: null, origin: null },
    { source_count: notes.length, bytes: bytesOf(markdown) },
  );
  return { markdown, count: notes.length };
}

export async function recordNoteShared(
  db: Executor,
  owner: NoteOwnerScope,
  note: NoteView,
): Promise<void> {
  await auditNote(db, owner, AuditAction.PERSONAL_NOTE_SHARED, "person", note, {
    source_count: note.source_count,
    bytes: bytesOf(note.text),
  });
}

export interface FoundNote {
  readonly id: string;
  readonly area: NoteArea;
  readonly abstract: string;
  readonly status: NoteStatus;
  readonly updated_at: Date;
}

function found(note: NoteView): FoundNote {
  return {
    id: note.id,
    area: note.area,
    abstract: note.abstract ?? clipAbstract(note.text),
    status: note.status,
    updated_at: note.updated_at,
  };
}

export async function searchNotes(
  db: Executor,
  owner: NoteOwnerScope,
  query: string,
  limit: number,
): Promise<{ hits: FoundNote[]; rest: FoundNote[] }> {
  const notes = await listNotes(db, owner);
  const ranked: NoteHit<NoteView & { confirmed: boolean }>[] = rankNotes(
    notes.map((note) => ({ ...note, confirmed: note.confirmed_at !== null })),
    query,
    limit,
  );
  const hit = new Set(ranked.map((entry) => entry.note.id));
  return {
    hits: ranked.map((entry) => found(entry.note)),
    rest: notes.filter((note) => !hit.has(note.id)).map(found),
  };
}
