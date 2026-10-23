import { describe, expect, test } from "bun:test";
import type { ActorDirectory } from "@/app/actor-directory-model";
import { translate } from "@/lib/i18n";
import {
  type FileVersion,
  fileKindKey,
  fileUsageLine,
  fileUsageParts,
  fileVersionContentPath,
  fileVersionTitle,
  fileVersionUploader,
  hasEarlierVersions,
} from "./file-versions-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);

function version(overrides: Partial<FileVersion>): FileVersion {
  return {
    version: 1,
    current: false,
    filename: "angebot.pdf",
    content_type: "application/pdf",
    size_bytes: 1024,
    sha256: null,
    restored_from: null,
    uploaded_at: "2026-10-01T08:00:00.000Z",
    uploaded_by: null,
    replaced_at: "2026-10-02T08:00:00.000Z",
    ...overrides,
  };
}

const emptyDirectory: ActorDirectory = new Map();
const directory: ActorDirectory = new Map([
  ["user:4f0e8c0e-1111-4111-8111-111111111111", "Mike Bild"],
]);

describe("file version titles", () => {
  test("name the first version, later uploads and restores as the prototype does", () => {
    expect(fileVersionTitle(version({ version: 1 }), de)).toBe("v1 · Erste Fassung");
    expect(fileVersionTitle(version({ version: 2 }), de)).toBe("v2 · Neue Fassung hochgeladen");
    expect(fileVersionTitle(version({ version: 3, restored_from: 1 }), de)).toBe(
      "v3 · Aus v1 wiederhergestellt",
    );
    expect(fileVersionTitle(version({ version: 3, restored_from: 1 }), en)).toBe(
      "v3 · Restored from v1",
    );
  });

  test("a known uploader is named from the directory", () => {
    expect(
      fileVersionUploader(
        version({ uploaded_by: { kind: "user", id: "4f0e8c0e-1111-4111-8111-111111111111" } }),
        directory,
        de,
      ),
    ).toBe("Mike Bild");
  });

  test("an unknown uploader reads as unknown, never as an identifier", () => {
    expect(fileVersionUploader(version({}), emptyDirectory, de)).toBe(
      translate("de", "runs.caller.unknown"),
    );
  });
});

describe("file version helpers", () => {
  test("only earlier versions open the replaced section", () => {
    expect(hasEarlierVersions([version({ current: true })])).toBe(false);
    expect(hasEarlierVersions([version({ current: true, version: 2 }), version({})])).toBe(true);
    expect(hasEarlierVersions(undefined)).toBe(false);
  });

  test("content paths address one version of the file", () => {
    expect(fileVersionContentPath("fid_1", 3)).toBe("/v1/files/fid_1/versions/3/content");
  });

  test("kind labels follow the preview kind", () => {
    expect(fileKindKey("a.pdf", null)).toBe("files.kind.pdf");
    expect(fileKindKey("a.bin", "application/octet-stream")).toBe("files.kind.other");
  });
});

describe("file usage summary", () => {
  test("counts every use, including records that are neither workflows nor conversations", () => {
    expect(fileUsageParts(de, { workflows: 0, conversations: 0, other: 1 })).toBe(
      "1 weiteren Eintrag",
    );
    expect(de("files.usage.summary", { uses: "1 weiteren Eintrag" })).toBe(
      "Genutzt von 1 weiteren Eintrag.",
    );
    expect(fileUsageParts(en, { workflows: 2, conversations: 1, other: 3 })).toBe(
      "2 workflows · 1 conversation · 3 other records",
    );
    expect(fileUsageLine(de, { workflows: 1, conversations: 0 })).toBe("genutzt von 1 Workflow");
  });

  test("says 'not used' only when nothing at all uses the file", () => {
    expect(fileUsageParts(de, { workflows: 0, conversations: 0, other: 0 })).toBeNull();
    expect(fileUsageParts(de, { workflows: 0, conversations: 0 })).toBeNull();
    expect(fileUsageParts(de, undefined)).toBeNull();
  });
});
