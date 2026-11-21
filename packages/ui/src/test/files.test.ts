import { describe, expect, it } from "bun:test";
import { extOf, FILE_ICON, fileKindOf, fileSize } from "@ui/lib/files";
import { File, FileImage } from "lucide-react";

describe("file kinds", () => {
  it("reads the extension case-insensitively, empty without a dot", () => {
    expect(extOf("Angebot.PDF")).toBe("pdf");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("README")).toBe("");
  });

  it("maps extensions to the five kinds", () => {
    expect(fileKindOf("photo.JPEG")).toBe("image");
    expect(fileKindOf("scan.webp")).toBe("image");
    expect(fileKindOf("angebot.pdf")).toBe("pdf");
    expect(fileKindOf("kunden.csv")).toBe("csv");
    expect(fileKindOf("notes.md")).toBe("md");
    expect(fileKindOf("data.json")).toBe("text");
    expect(fileKindOf("README")).toBe("text");
  });

  it("has one icon per kind", () => {
    expect(FILE_ICON.image).toBe(FileImage);
    expect(FILE_ICON.text).toBe(File);
    expect(Object.keys(FILE_ICON).sort()).toEqual(["csv", "image", "md", "pdf", "text"]);
  });
});

describe("file size", () => {
  it("shows whole KB below one MB", () => {
    expect(fileSize(48_400, "de")).toBe("48 KB");
    expect(fileSize(1_500, "en")).toBe("2 KB");
  });

  it("shows one decimal in MB, in the language's number format", () => {
    expect(fileSize(1_250_000, "de")).toBe("1,3 MB");
    expect(fileSize(1_250_000, "en")).toBe("1.3 MB");
    expect(fileSize(5_000_000, "de")).toBe("5 MB");
  });
});
