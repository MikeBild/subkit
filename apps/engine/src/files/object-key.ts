// Object-store key helpers shared by the canonical files routes
// (`POST /v1/files/inline`, `POST /v1/files/batch-create`) and the
// portal-wrapper attachment route
// (`POST /v1/conversations/:id/attachments`). The helpers were
// declared in both routes verbatim; consolidating them here removes
// the drift surface so a future change to the key shape (e.g. extra
// partition column) lands once.

import { getConfig, isConfigLoaded } from "../config/loader.ts";

/** Object-store key shape: `<tenant>/<yyyy>/<mm>/<dd>/<uuid>`.
 *
 *  - The `<tenant>` prefix bounds the tenant-isolation blast radius
 *    at the storage layer so an accidental `list` against the bucket
 *    cannot walk across tenants.
 *  - Date partitioning keeps cold-storage lifecycle rules (S3
 *    lifecycle policies, local-disk archive sweeps) cheap because
 *    they can target whole `yyyy/mm/dd/` prefixes.
 *  - The filename lives in the DB row, never in the path — keeps
 *    keys short and PII-free.
 *
 *  `now` is injected so tests can pin the partition deterministically. */
export function buildObjectKey(
  tenant_id: string,
  file_uuid: string,
  now: Date = new Date(),
): string {
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${tenant_id}/${yyyy}/${mm}/${dd}/${file_uuid}`;
}

/** Compose the S3 locator while keeping PostgreSQL as the active pointer. */
export function composeStorageUri(key: string): string {
  const bucket = isConfigLoaded() ? getConfig().storage.object_store.bucket : "test";
  return `s3://${bucket || "test"}/${key}`;
}

/** Open an iterator over a fixed byte buffer for the synchronous scan
 *  + sha256 path. Avoids holding the whole stream API surface for
 *  in-memory payloads while still satisfying `ScanMeta`. */
export function streamFromBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}
