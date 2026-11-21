import { createHash } from "node:crypto";
import {
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_LIFETIME_MS,
  type UploadCommit,
  type UploadCreate,
  type UploadRefusal,
} from "@shared/device/uploads.ts";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { deviceCommands, deviceUploadChunks, deviceUploads } from "../db/schema/index.ts";
import { assertHostedFileAdmission, HostedFileQuotaError } from "../files/hosted-quota.ts";
import { createInlineFile } from "../files/service/index.ts";
import { logger } from "../logging/index.ts";
import { getBoss } from "../queue/boss.ts";
import { DEVICE_WAIT_QUEUE, type DeviceWaitJob } from "../queue/queues.ts";
import { chunkVerdict, commitVerdict, sizeAllowed } from "./core/upload.ts";
import { type RunnerIdentity, runnerPrincipal } from "./runner-auth.ts";

export type UploadOutcome<T> = { ok: true; value: T } | { ok: false; code: UploadRefusal };

type UploadRow = typeof deviceUploads.$inferSelect;

function refused<T>(code: UploadRefusal): UploadOutcome<T> {
  return { ok: false, code };
}

function facts(row: UploadRow) {
  return { state: row.state, size_bytes: row.size_bytes, expires_at_ms: row.expires_at.getTime() };
}

async function ownUpload(
  db: Executor,
  runner: RunnerIdentity,
  upload_id: string,
  lock: boolean,
): Promise<UploadRow | null> {
  const query = db
    .select()
    .from(deviceUploads)
    .where(
      and(
        eq(deviceUploads.tenant_id, runner.tenant_id),
        eq(deviceUploads.device_id, runner.device_id),
        eq(deviceUploads.id, upload_id),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

async function dropChunks(db: Executor, row: Pick<UploadRow, "tenant_id" | "id">): Promise<void> {
  await db
    .delete(deviceUploadChunks)
    .where(
      and(
        eq(deviceUploadChunks.tenant_id, row.tenant_id),
        eq(deviceUploadChunks.upload_id, row.id),
      ),
    );
}

export async function openUpload(
  db: Db,
  runner: RunnerIdentity,
  input: UploadCreate,
  now_ms: number,
): Promise<UploadOutcome<{ upload_id: string; chunk_bytes_max: number; expires_at: Date }>> {
  const [command] = await db
    .select({ kind: deviceCommands.kind, state: deviceCommands.state })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.tenant_id, runner.tenant_id),
        eq(deviceCommands.device_id, runner.device_id),
        eq(deviceCommands.id, input.command_id),
      ),
    )
    .limit(1);
  if (!command) return refused("command_not_found");
  if (command.kind !== "files.import") return refused("not_an_import");
  if (command.state !== "claimed") return refused("command_not_running");
  if (!sizeAllowed(input.size)) return refused("too_large");
  try {
    return await db.transaction(async (tx) => {
      await assertHostedFileAdmission(tx, runner.tenant_id, input.size);
      const expires_at = new Date(now_ms + UPLOAD_LIFETIME_MS);
      const [row] = await tx
        .insert(deviceUploads)
        .values({
          tenant_id: runner.tenant_id,
          device_id: runner.device_id,
          command_id: input.command_id,
          name: input.name,
          size_bytes: input.size,
          state: "open",
          expires_at,
        })
        .returning({ id: deviceUploads.id });
      if (!row) throw new Error("device upload was not created");
      return {
        ok: true as const,
        value: { upload_id: row.id, chunk_bytes_max: UPLOAD_CHUNK_MAX_BYTES, expires_at },
      };
    });
  } catch (error) {
    if (error instanceof HostedFileQuotaError) return refused("quota_exhausted");
    throw error;
  }
}

export async function putChunk(
  db: Db,
  runner: RunnerIdentity,
  upload_id: string,
  n: number,
  bytes: Uint8Array,
  now_ms: number,
): Promise<UploadOutcome<{ received_bytes: number }>> {
  return db.transaction(async (tx) => {
    const row = await ownUpload(tx, runner, upload_id, true);
    if (!row) return refused("upload_not_found");
    const [existing] = await tx
      .select({ bytes: sql<number>`octet_length(${deviceUploadChunks.bytes})` })
      .from(deviceUploadChunks)
      .where(
        and(
          eq(deviceUploadChunks.tenant_id, row.tenant_id),
          eq(deviceUploadChunks.upload_id, row.id),
          eq(deviceUploadChunks.n, n),
        ),
      )
      .limit(1);
    const [sum] = await tx
      .select({
        bytes: sql<string>`coalesce(sum(octet_length(${deviceUploadChunks.bytes})), 0)::text`,
      })
      .from(deviceUploadChunks)
      .where(
        and(
          eq(deviceUploadChunks.tenant_id, row.tenant_id),
          eq(deviceUploadChunks.upload_id, row.id),
        ),
      );
    const received_bytes = Number(sum?.bytes ?? "0");
    const verdict = chunkVerdict(
      facts(row),
      {
        n,
        bytes: bytes.byteLength,
        received_bytes,
        existing_bytes: existing ? Number(existing.bytes) : null,
      },
      now_ms,
    );
    if (verdict) return refused(verdict);
    if (existing) return { ok: true, value: { received_bytes } };
    await tx
      .insert(deviceUploadChunks)
      .values({ upload_id: row.id, tenant_id: row.tenant_id, n, bytes });
    return { ok: true, value: { received_bytes: received_bytes + bytes.byteLength } };
  });
}

export async function commitUpload(
  db: Db,
  runner: RunnerIdentity,
  upload_id: string,
  commit: UploadCommit,
  now_ms: number,
): Promise<UploadOutcome<{ file_id: string }>> {
  const row = await ownUpload(db, runner, upload_id, false);
  if (!row) return refused("upload_not_found");
  if (row.state === "committed" && row.file_id)
    return { ok: true, value: { file_id: row.file_id } };
  const chunks = await db
    .select({ n: deviceUploadChunks.n, bytes: deviceUploadChunks.bytes })
    .from(deviceUploadChunks)
    .where(
      and(
        eq(deviceUploadChunks.tenant_id, row.tenant_id),
        eq(deviceUploadChunks.upload_id, row.id),
      ),
    )
    .orderBy(asc(deviceUploadChunks.n));
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)));
  const verdict = commitVerdict(
    facts(row),
    {
      size: commit.size,
      sha256: commit.sha256,
      chunks: chunks.map((chunk) => chunk.n),
      actual_sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    now_ms,
  );
  if (verdict === "hash_mismatch") {
    await closeUpload(db, row, "aborted");
    return refused(verdict);
  }
  if (verdict) return refused(verdict);
  let stored: Awaited<ReturnType<typeof createInlineFile>>;
  try {
    stored = await createInlineFile(
      db,
      { principal: runnerPrincipal(runner), request_source: "api" },
      { filename: row.name, content_type: null, bytes, started_at: now_ms },
    );
  } catch (error) {
    if (error instanceof HostedFileQuotaError) return refused("quota_exhausted");
    throw error;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(deviceUploads)
      .set({ state: "committed", file_id: stored.row.id })
      .where(and(eq(deviceUploads.tenant_id, row.tenant_id), eq(deviceUploads.id, row.id)));
    await dropChunks(tx, row);
  });
  return { ok: true, value: { file_id: stored.row.id } };
}

async function closeUpload(
  db: Db,
  row: Pick<UploadRow, "tenant_id" | "id">,
  state: "aborted" | "expired",
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [closed] = await tx
      .update(deviceUploads)
      .set({ state })
      .where(
        and(
          eq(deviceUploads.tenant_id, row.tenant_id),
          eq(deviceUploads.id, row.id),
          eq(deviceUploads.state, "open"),
        ),
      )
      .returning({ id: deviceUploads.id });
    if (closed) await dropChunks(tx, row);
    return Boolean(closed);
  });
}

export async function abortUpload(
  db: Db,
  runner: RunnerIdentity,
  upload_id: string,
): Promise<UploadOutcome<{ aborted: boolean }>> {
  const row = await ownUpload(db, runner, upload_id, false);
  if (!row) return refused("upload_not_found");
  return { ok: true, value: { aborted: await closeUpload(db, row, "aborted") } };
}

export async function scheduleUploadExpiry(tenant_id: string, at: Date): Promise<void> {
  try {
    await getBoss().send(
      DEVICE_WAIT_QUEUE,
      { tenant_id, phase: "upload_expire" } satisfies DeviceWaitJob,
      { startAfter: at },
    );
  } catch (error) {
    logger.warn({
      module: "devices",
      action: "device_upload.expiry_unscheduled",
      msg: "the upload still refuses chunks after an hour; its staged bytes wait for the next expiry",
      tenant_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function expireUploads(db: Db, tenant_id: string, now: Date): Promise<number> {
  const due = await db
    .select({ id: deviceUploads.id, tenant_id: deviceUploads.tenant_id })
    .from(deviceUploads)
    .where(
      and(
        eq(deviceUploads.tenant_id, tenant_id),
        eq(deviceUploads.state, "open"),
        sql`${deviceUploads.expires_at} <= ${now}`,
      ),
    )
    .limit(500);
  let expired = 0;
  for (const row of due) if (await closeUpload(db, row, "expired")) expired += 1;
  return expired;
}

export async function committedImport(
  db: Executor,
  tenant_id: string,
  command_id: string,
  file_id: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: deviceUploads.id })
    .from(deviceUploads)
    .where(
      and(
        eq(deviceUploads.tenant_id, tenant_id),
        eq(deviceUploads.command_id, command_id),
        eq(deviceUploads.state, "committed"),
        eq(deviceUploads.file_id, file_id),
      ),
    )
    .limit(1);
  return Boolean(row);
}
