import { walkZipEntries } from "../../utils/zip-walk.ts";
import { isSafeArchivePath } from "../../utils/zip-write.ts";
import {
  blobPath,
  connectorKey,
  contentDigest,
  itemPath,
  PACKAGE_MAX_BYTES,
  PACKAGE_MAX_COMPRESSION_RATIO,
  PACKAGE_MAX_ENTRIES,
  PACKAGE_MAX_ENTRY_BYTES,
  PAYLOAD_SCHEMAS,
  type PackageManifest,
  PackageManifestSchema,
  type PackagePayload,
  sha256Hex,
  sortPayloads,
} from "./format.ts";

const UNSAFE_ENTRY_NAME = /absolute path|invalid relative path|invalid characters in fileName/i;

export type PackageArchiveErrorCode =
  | "package_archive_invalid"
  | "package_archive_too_large"
  | "package_archive_unsafe_path"
  | "package_manifest_invalid"
  | "package_checksum_mismatch";

export class PackageArchiveError extends Error {
  constructor(
    readonly code: PackageArchiveErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface ReadPackage {
  manifest: PackageManifest;
  payloads: PackagePayload[];
}

function payloadKey(item: PackagePayload): string {
  switch (item.kind) {
    case "connector":
      return connectorKey(item.payload.slug, item.payload.environment);
    case "file":
      return item.payload.sha256;
    case "schedule":
      return item.payload.workflow;
    default:
      return item.payload.slug;
  }
}

export async function readPackageArchive(archive: Buffer): Promise<ReadPackage> {
  if (archive.byteLength > PACKAGE_MAX_BYTES) {
    throw new PackageArchiveError("package_archive_too_large", `${archive.byteLength} bytes`);
  }
  let walked: Awaited<ReturnType<typeof walkZipEntries>>;
  try {
    walked = await walkZipEntries(archive, {
      maxEntries: PACKAGE_MAX_ENTRIES,
      maxPerEntryBytes: PACKAGE_MAX_ENTRY_BYTES,
      maxTotalBytes: PACKAGE_MAX_BYTES,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (UNSAFE_ENTRY_NAME.test(message)) {
      throw new PackageArchiveError("package_archive_unsafe_path", message.slice(0, 300));
    }
    throw new PackageArchiveError("package_archive_invalid", "not a readable zip archive");
  }
  if (walked.truncated || walked.skipped_reasons.too_large) {
    throw new PackageArchiveError("package_archive_too_large", "entry or total size limit reached");
  }
  if (walked.skipped_count > 0) {
    throw new PackageArchiveError("package_archive_invalid", "archive contains unreadable entries");
  }
  if (walked.total_bytes > Math.max(archive.byteLength, 1) * PACKAGE_MAX_COMPRESSION_RATIO) {
    throw new PackageArchiveError("package_archive_too_large", "compression ratio limit reached");
  }
  const entries = new Map<string, Buffer>();
  for (const entry of walked.entries) {
    if (!isSafeArchivePath(entry.path)) {
      throw new PackageArchiveError("package_archive_unsafe_path", entry.path);
    }
    if (entries.has(entry.path)) {
      throw new PackageArchiveError("package_archive_invalid", `duplicate entry ${entry.path}`);
    }
    entries.set(entry.path, entry.buffer);
  }
  const rawManifest = entries.get("manifest.json");
  if (!rawManifest)
    throw new PackageArchiveError("package_manifest_invalid", "manifest.json missing");
  let manifest: PackageManifest;
  try {
    manifest = PackageManifestSchema.parse(JSON.parse(rawManifest.toString("utf8")));
  } catch (err) {
    throw new PackageArchiveError(
      "package_manifest_invalid",
      err instanceof Error ? err.message.slice(0, 500) : "manifest unreadable",
    );
  }
  const expected = new Set<string>(["manifest.json"]);
  const payloads: PackagePayload[] = [];
  const seen = new Set<string>();
  for (const item of manifest.items) {
    if (item.path !== itemPath(item.kind, item.key)) {
      throw new PackageArchiveError("package_archive_unsafe_path", item.path);
    }
    if (seen.has(`${item.kind}:${item.key}`)) {
      throw new PackageArchiveError("package_manifest_invalid", `duplicate item ${item.key}`);
    }
    seen.add(`${item.kind}:${item.key}`);
    expected.add(item.path);
    const bytes = entries.get(item.path);
    if (!bytes) throw new PackageArchiveError("package_archive_invalid", `${item.path} missing`);
    if (sha256Hex(bytes) !== item.sha256) {
      throw new PackageArchiveError("package_checksum_mismatch", item.path);
    }
    let parsed: unknown;
    try {
      parsed = PAYLOAD_SCHEMAS[item.kind].parse(JSON.parse(bytes.toString("utf8")));
    } catch (err) {
      throw new PackageArchiveError(
        "package_manifest_invalid",
        `${item.path}: ${err instanceof Error ? err.message.slice(0, 300) : "invalid"}`,
      );
    }
    let payload: PackagePayload;
    if (item.kind === "file") {
      const blob = blobPath(item.key);
      if (item.blob_path !== blob || !item.blob_sha256) {
        throw new PackageArchiveError("package_manifest_invalid", `${item.path}: blob reference`);
      }
      expected.add(blob);
      const data = entries.get(blob);
      if (!data) throw new PackageArchiveError("package_archive_invalid", `${blob} missing`);
      const dataSha = sha256Hex(data);
      if (dataSha !== item.blob_sha256 || dataSha !== item.key) {
        throw new PackageArchiveError("package_checksum_mismatch", blob);
      }
      payload = {
        kind: "file",
        key: item.key,
        payload: PAYLOAD_SCHEMAS.file.parse(parsed),
        bytes: new Uint8Array(data),
      };
    } else {
      payload = { kind: item.kind, key: item.key, payload: parsed } as PackagePayload;
    }
    if (payloadKey(payload) !== item.key) {
      throw new PackageArchiveError("package_manifest_invalid", `${item.path}: key mismatch`);
    }
    payloads.push(payload);
  }
  for (const path of entries.keys()) {
    if (!expected.has(path)) {
      throw new PackageArchiveError("package_archive_unsafe_path", `unexpected entry ${path}`);
    }
  }
  if (contentDigest(manifest.items) !== manifest.content_digest) {
    throw new PackageArchiveError("package_checksum_mismatch", "content_digest");
  }
  return { manifest, payloads: sortPayloads(payloads) };
}
