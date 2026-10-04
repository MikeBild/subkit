import { getConfig, isConfigLoaded } from "../config/loader.ts";

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

export function composeStorageUri(key: string): string {
  const bucket = isConfigLoaded() ? getConfig().storage.object_store.bucket : "test";
  return `s3://${bucket || "test"}/${key}`;
}

export function streamFromBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}
