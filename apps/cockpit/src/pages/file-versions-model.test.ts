import { describe, expect, test } from "bun:test";
import type { ActorDirectory } from "@/app/actor-directory-model";
import { translate } from "@/lib/i18n";
import {
  type FileVersion,
  fileKindKey,
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
