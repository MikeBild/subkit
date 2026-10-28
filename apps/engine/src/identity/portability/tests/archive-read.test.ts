import { describe, expect, test } from "bun:test";
import { writeDeterministicZip } from "../../../utils/zip-write.ts";
import { PackageArchiveError, readPackageArchive } from "../archive-read.ts";
import type { CollectedPackage } from "../collect.ts";
import { buildPackageArchive } from "../export.ts";
import { PACKAGE_MAX_BYTES, type SkillPayload, sha256Hex } from "../format.ts";

const SOURCE = { instance: "https://source.example.test", engine_version: "0.0.0-test" };
const EXPORTED_AT = "2026-01-01T00:00:00.000Z";

function skill(slug: string, body: string): SkillPayload {
  return {
    slug,
    title: `Skill ${slug}`,
    description: null,
    category: null,
    body,
    scope: "global",
    connector: null,
    workflow: null,
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    gates_tools: [],
    activates_when: [],
    input_schema: null,
    output_schema: null,
    side_effects: "none",
    idempotency: "idempotent",
    maturity: "draft",
    tags: [],
    applies_to: "any",
  };
}

function emptyIndex(): CollectedPackage["index"] {
  return {
    connector_templates: new Map(),
    connectors: new Map(),
    files: new Map(),
    skills: new Map(),
    workflows: new Map(),
    schedules: new Map(),
    knowledge: new Map(),
  };
}

function collected(order: "forward" | "reverse" = "forward"): CollectedPackage {
  const fileBytes = new TextEncoder().encode("hello package file");
  const fileSha = sha256Hex(fileBytes);
  const payloads: CollectedPackage["payloads"] = [
    { kind: "skill", key: "alpha", payload: skill("alpha", "Alpha body") },
    { kind: "skill", key: "beta", payload: skill("beta", "Beta body") },
    {
      kind: "file",
      key: fileSha,
      payload: {
        sha256: fileSha,
        filename: "hello.txt",
        content_type: "text/plain",
        size_bytes: fileBytes.byteLength,
        slug: null,
        description: null,
        category: null,
        links: [],
      },
      bytes: fileBytes,
    },
  ];
  const requires: CollectedPackage["requires"] = [
    { kind: "approval", workflow: "zeta" },
    { kind: "approval", workflow: "alpha" },
  ];
  return {
    tenant_slug: "source",
    payloads: order === "forward" ? payloads : [...payloads].reverse(),
    requires: order === "forward" ? requires : [...requires].reverse(),
    index: emptyIndex(),
  };
}

function entriesOf(): Map<string, Uint8Array> {
  const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
  const entries = new Map<string, Uint8Array>();
  for (const item of built.manifest.items) {
    entries.set(item.path, new TextEncoder().encode(`${JSON.stringify(item)}`));
  }
  return entries;
}

async function rawEntries(archive: Buffer): Promise<Map<string, Uint8Array>> {
  const { walkZipEntries } = await import("../../../utils/zip-walk.ts");
  const walked = await walkZipEntries(archive, {
    maxEntries: 100,
    maxPerEntryBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
  });
  return new Map(walked.entries.map((entry) => [entry.path, new Uint8Array(entry.buffer)]));
}

function patchName(archive: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error("patch names must have equal length");
  const out = Buffer.from(archive);
  const needle = Buffer.from(from);
  let at = out.indexOf(needle);
  let hits = 0;
  while (at !== -1) {
    out.write(to, at);
    hits += 1;
    at = out.indexOf(needle, at + needle.length);
  }
  if (hits !== 2) throw new Error(`expected local and central name for ${from}, found ${hits}`);
  return out;
}

async function expectArchiveError(archive: Buffer, code: string, detail?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await readPackageArchive(archive);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PackageArchiveError);
  const error = caught as PackageArchiveError;
  expect(error.code).toBe(code as PackageArchiveError["code"]);
  if (detail) expect(error.detail).toMatch(detail);
}

describe("buildPackageArchive", () => {
  test("produces identical bytes for the same content regardless of input order", () => {
    const first = buildPackageArchive(collected("forward"), SOURCE, EXPORTED_AT);
    const second = buildPackageArchive(collected("reverse"), SOURCE, EXPORTED_AT);
    expect(sha256Hex(first.archive)).toBe(sha256Hex(second.archive));
    expect(first.manifest.requires).toEqual([
      { kind: "approval", workflow: "alpha" },
      { kind: "approval", workflow: "zeta" },
    ]);
  });

  test("round-trips through readPackageArchive", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const read = await readPackageArchive(built.archive);
    expect(read.manifest.content_digest).toBe(built.manifest.content_digest);
    expect(read.payloads.map((item) => `${item.kind}:${item.key}`)).toEqual(
      built.manifest.items.map((item) => `${item.kind}:${item.key}`),
    );
    const file = read.payloads.find((item) => item.kind === "file");
    expect(file?.kind === "file" && new TextDecoder().decode(file.bytes)).toBe(
      "hello package file",
    );
  });
});

describe("readPackageArchive rejects unsafe archives", () => {
  test("rejects a parent-directory entry", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    entries.set("aa/x", new TextEncoder().encode("evil"));
    await expectArchiveError(
      patchName(writeDeterministicZip(entries), "aa/x", "../x"),
      "package_archive_unsafe_path",
    );
  });

  test("rejects an absolute entry", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    entries.set("zz/evil", new TextEncoder().encode("evil"));
    await expectArchiveError(
      patchName(writeDeterministicZip(entries), "zz/evil", "/z/evil"),
      "package_archive_unsafe_path",
    );
  });

  test("rejects an entry the manifest does not list", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    entries.set("skills/extra.json", new TextEncoder().encode("{}"));
    await expectArchiveError(
      writeDeterministicZip(entries),
      "package_archive_unsafe_path",
      /unexpected entry skills\/extra\.json/,
    );
  });

  test("rejects a payload whose checksum does not match", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    entries.set(
      "skills/alpha.json",
      new TextEncoder().encode(`${JSON.stringify(skill("alpha", "Tampered body"))}\n`),
    );
    await expectArchiveError(
      writeDeterministicZip(entries),
      "package_checksum_mismatch",
      /skills\/alpha\.json/,
    );
  });

  test("rejects a file blob whose checksum does not match", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    const blob = [...entries.keys()].find((path) => path.endsWith(".bin"));
    if (!blob) throw new Error("fixture has no blob");
    entries.set(blob, new TextEncoder().encode("other bytes"));
    await expectArchiveError(writeDeterministicZip(entries), "package_checksum_mismatch");
  });

  test("rejects duplicate entries", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    const original = entries.get("skills/alpha.json");
    if (!original) throw new Error("fixture has no alpha skill");
    entries.set("skills/alphb.json", original);
    await expectArchiveError(
      patchName(writeDeterministicZip(entries), "skills/alphb.json", "skills/alpha.json"),
      "package_archive_invalid",
      /duplicate entry/,
    );
  });

  test("rejects an archive without manifest", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    entries.delete("manifest.json");
    await expectArchiveError(
      writeDeterministicZip(entries),
      "package_manifest_invalid",
      /manifest\.json missing/,
    );
  });

  test("rejects a manifest that is not a package manifest", async () => {
    await expectArchiveError(writeDeterministicZip(entriesOf()), "package_manifest_invalid");
  });

  test("rejects an archive above the byte limit", async () => {
    await expectArchiveError(Buffer.alloc(PACKAGE_MAX_BYTES + 1), "package_archive_too_large");
  });

  test("rejects an entry above the compression ratio limit", async () => {
    const built = buildPackageArchive(collected(), SOURCE, EXPORTED_AT);
    const entries = await rawEntries(built.archive);
    entries.set("bomb.bin", new Uint8Array(1024 * 1024));
    await expectArchiveError(
      writeDeterministicZip(entries),
      "package_archive_too_large",
      /compression ratio/,
    );
  });

  test("rejects bytes that are not a zip", async () => {
    await expectArchiveError(Buffer.from("not a zip"), "package_archive_invalid");
  });
});
