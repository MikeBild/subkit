import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import {
  type ChatComposerAttachmentRow,
  chatComposerAttachments,
  files,
} from "../db/schema/index.ts";
import { composerExpiry, liveEntries, trayAdmission } from "./composer-tray-model.ts";
import type { FileRow } from "./resolver.ts";

export interface TrayOwner {
  tenant_id: string;
  user_id: string;
}

export interface TrayItem {
  entry: ChatComposerAttachmentRow;
  file: FileRow;
}

export class ComposerTrayFullError extends Error {
  constructor() {
    super("composer_full");
    this.name = "ComposerTrayFullError";
  }
}

function ownedBy(owner: TrayOwner) {
  return and(
    eq(chatComposerAttachments.tenant_id, owner.tenant_id),
    eq(chatComposerAttachments.user_id, owner.user_id),
  );
}

async function dropExpired(tx: Executor, owner: TrayOwner, now: Date): Promise<void> {
  await tx
    .delete(chatComposerAttachments)
    .where(and(ownedBy(owner), lte(chatComposerAttachments.expires_at, now)));
}

export async function stageComposerFile(
  db: Db,
  owner: TrayOwner,
  staged: { file_id: string; slug: string },
  now: Date,
): Promise<ChatComposerAttachmentRow> {
  return db.transaction(async (tx) => {
    await dropExpired(tx, owner, now);
    const current = await tx
      .select()
      .from(chatComposerAttachments)
      .where(ownedBy(owner))
      .for("update");
    const admission = trayAdmission(liveEntries(current, now), staged.file_id);
    if (admission === "full") throw new ComposerTrayFullError();
    const expires_at = composerExpiry(now);
    const [row] = await tx
      .insert(chatComposerAttachments)
      .values({ ...owner, file_id: staged.file_id, slug: staged.slug, expires_at })
      .onConflictDoUpdate({
        target: [
          chatComposerAttachments.tenant_id,
          chatComposerAttachments.user_id,
          chatComposerAttachments.file_id,
        ],
        set: { expires_at, slug: staged.slug },
      })
      .returning();
    if (!row) throw new Error("composer tray row was not written");
    return row;
  });
}

export async function listComposerTray(
  db: Executor,
  owner: TrayOwner,
  now: Date,
): Promise<TrayItem[]> {
  const rows = await db
    .select({ entry: chatComposerAttachments, file: files })
    .from(chatComposerAttachments)
    .innerJoin(
      files,
      and(
        eq(files.tenant_id, chatComposerAttachments.tenant_id),
        eq(files.id, chatComposerAttachments.file_id),
      ),
    )
    .where(ownedBy(owner))
    .orderBy(desc(chatComposerAttachments.created_at), asc(chatComposerAttachments.id));
  return rows.filter(
    (row) => row.file.deleted_at === null && row.entry.expires_at.getTime() > now.getTime(),
  );
}

export async function removeComposerFile(
  db: Executor,
  owner: TrayOwner,
  id: string,
): Promise<ChatComposerAttachmentRow | null> {
  const [row] = await db
    .delete(chatComposerAttachments)
    .where(and(ownedBy(owner), eq(chatComposerAttachments.id, id)))
    .returning();
  return row ?? null;
}

export async function removeComposerFiles(
  db: Executor,
  owner: TrayOwner,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .delete(chatComposerAttachments)
    .where(and(ownedBy(owner), inArray(chatComposerAttachments.id, [...ids])));
}
