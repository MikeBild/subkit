import { actorType } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { type FileRow, requireFileForTenant, requireLiveFileForTenant } from "../resolver.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS, type ScanResult } from "../scanner.ts";

export type { FileRow };

export interface FileActor {
  principal: ResolvedPrincipal;
  request_source: RequestSource | undefined;
}

export function auditedBy(actor: FileActor) {
  return {
    tenant_id: actor.principal.tenant_id,
    actor_type: actorType(actor.principal),
    actor_id: actor.principal.id,
  };
}

export function creatorId(principal: ResolvedPrincipal): string | null {
  return principal.kind === "user" || principal.kind === "system_account" ? principal.id : null;
}

export function scanVerdictResult(verdict: string): "success" | "error" | "denied" {
  return verdict === "clean" ? "success" : verdict === "timeout" ? "error" : "denied";
}

export async function findTenantFile(
  db: Db,
  tenantId: string,
  fileUuid: string,
): Promise<FileRow | null> {
  try {
    return await requireFileForTenant(db, tenantId, fileUuid);
  } catch {
    return null;
  }
}

export async function findLiveFile(
  db: Db,
  tenantId: string,
  fileUuid: string,
): Promise<FileRow | null> {
  try {
    return await requireLiveFileForTenant(db, tenantId, fileUuid);
  } catch {
    return null;
  }
}

export async function scanWithTimeout(
  stream: AsyncIterable<Uint8Array>,
  meta: { content_type: string | null; filename: string },
): Promise<ScanResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ScanResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ verdict: "timeout", engine: "timeout" }),
      SCANNER_TIMEOUT_SECONDS * 1000,
    );
  });
  try {
    return await Promise.race([getScanner().scan(stream, meta), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function openObjectStream(
  key: string,
  range: { start: number; end: number } | null,
): Promise<ReadableStream<Uint8Array>> {
  const iterable = range
    ? await getObjectStore().openReadRange(key, { start: range.start, end: range.end })
    : await getObjectStore().openRead(key);
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await iterator.return?.(reason);
      } catch {}
    },
  });
}
