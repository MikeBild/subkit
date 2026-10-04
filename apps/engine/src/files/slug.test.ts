import { describe, expect, test } from "bun:test";
import { fileReference, parseFileReference, slugifyFilename } from "./slug.ts";

describe("slugifyFilename", () => {
  test.each([
    ["Übersicht Q3.pdf", "uebersicht-q3"],
    ["_Größe.tar.gz", "groesse-tar"],
    ["???.png", "file"],
    ["Rechnung 2026-01.PDF", "rechnung-2026-01"],
    ["ÄÖÜ äöü ß", "aeoeue-aeoeue-ss"],
    ["no-extension", "no-extension"],
  ])("%s → %s", (name, slug) => {
    expect(slugifyFilename(name)).toBe(slug);
  });

  test("keeps at most 48 characters and never ends on a separator", () => {
    const slug = slugifyFilename(`${"a".repeat(47)} b.txt`);
    expect(slug).toBe("a".repeat(47));
  });

  test("always fits the chat token grammar", () => {
    for (const name of ["Übersicht Q3.pdf", "-x-.md", "...", "Ünïcödé 😀 name.txt"]) {
      expect(slugifyFilename(name)).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
    }
  });
});

describe("reference", () => {
  test("round-trips a slug", () => {
    expect(fileReference("report")).toBe("@attachment:report");
    expect(parseFileReference("@attachment:report")).toBe("report");
    expect(fileReference(null)).toBeNull();
    expect(parseFileReference("fid_x")).toBeNull();
    expect(parseFileReference("@attachment:Bad Slug")).toBeNull();
  });
});
