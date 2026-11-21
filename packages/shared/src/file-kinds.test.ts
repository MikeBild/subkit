import { describe, expect, test } from "bun:test";
import {
  csvPreview,
  extOf,
  fileKindOf,
  fileRefusal,
  formatBytes,
  parseCsv,
  previewKind,
} from "./file-kinds.ts";

describe("extOf", () => {
  test("reads the last extension case-insensitively, empty without a dot", () => {
    expect(extOf("Angebot.PDF")).toBe("pdf");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("README")).toBe("");
    expect(extOf(".env")).toBe("env");
    expect(extOf("name.")).toBe("");
  });
});

describe("fileKindOf", () => {
  test("maps extensions to the five kinds", () => {
    expect(fileKindOf("photo.JPEG")).toBe("image");
    expect(fileKindOf("a.png")).toBe("image");
    expect(fileKindOf("a.jpg")).toBe("image");
    expect(fileKindOf("a.gif")).toBe("image");
    expect(fileKindOf("scan.webp")).toBe("image");
    expect(fileKindOf("angebot.pdf")).toBe("pdf");
    expect(fileKindOf("kunden.csv")).toBe("csv");
    expect(fileKindOf("notes.md")).toBe("md");
    expect(fileKindOf("data.json")).toBe("text");
    expect(fileKindOf("logo.svg")).toBe("text");
    expect(fileKindOf("README")).toBe("text");
  });
});

describe("previewKind", () => {
  test("the content type wins, the extension decides without one", () => {
    expect(previewKind("a.bin", "image/png")).toBe("image");
    expect(previewKind("a.bin", "Image/PNG; charset=x")).toBe("image");
    expect(previewKind("a.bin", "application/pdf")).toBe("pdf");
    expect(previewKind("doc.pdf", "application/octet-stream")).toBe("pdf");
    expect(previewKind("a.bin", "text/csv")).toBe("csv");
    expect(previewKind("export.csv", "application/octet-stream")).toBe("csv");
    expect(previewKind("a.bin", "text/markdown")).toBe("markdown");
    expect(previewKind("notes.md", "")).toBe("markdown");
    expect(previewKind("notes.markdown", null)).toBe("markdown");
    expect(previewKind("a.bin", "text/plain")).toBe("text");
    expect(previewKind("a.bin", "application/json")).toBe("text");
    expect(previewKind("config.toml", undefined)).toBe("text");
    for (const ext of ["txt", "json", "yaml", "yml", "log", "xml", "ts", "js", "sql", "toml"])
      expect(previewKind(`file.${ext}`, null)).toBe("text");
    expect(previewKind("data", "Text/CSV ; charset=utf-8")).toBe("csv");
    expect(previewKind("logo.svg", null)).toBe("image");
    expect(previewKind("logo.svg", "")).toBe("image");
    expect(previewKind("photo.webp", "")).toBe("image");
    expect(previewKind("photo.webp", "application/octet-stream")).toBe("other");
    expect(previewKind("archive.zip", "application/zip")).toBe("other");
    expect(previewKind("archive.zip", "")).toBe("other");
  });
});

describe("fileRefusal", () => {
  const png = { name: "a.png", type: "image/png", size: 10 };

  test("refuses by size first, at the limit it still fits", () => {
    expect(fileRefusal(png, { maxBytes: 5, accept: "image/*" })).toBe("size");
    expect(fileRefusal(png, { maxBytes: 10 })).toBeNull();
    expect(fileRefusal(png, {})).toBeNull();
  });

  test("accepts by extension, exact type or type family", () => {
    expect(fileRefusal(png, { accept: "image/*" })).toBeNull();
    expect(fileRefusal(png, { accept: " IMAGE/PNG " })).toBeNull();
    expect(fileRefusal({ ...png, type: "IMAGE/PNG" }, { accept: "image/png" })).toBeNull();
    expect(fileRefusal(png, { accept: ".csv,application/pdf" })).toBe("type");
    expect(fileRefusal(png, { accept: "image/png+x" })).toBe("type");
    expect(fileRefusal(png, { accept: "text/*" })).toBe("type");
    expect(fileRefusal({ name: "x.CSV", type: "", size: 1 }, { accept: ".csv" })).toBeNull();
    expect(fileRefusal({ name: "x.csv", type: "", size: 1 }, { accept: "csv" })).toBe("type");
    expect(fileRefusal(png, { accept: "text/csv,image/*" })).toBeNull();
    expect(fileRefusal(png, { accept: "image/pn" })).toBe("type");
    expect(fileRefusal({ ...png, type: "info/x" }, { accept: "image/*" })).toBe("type");
    expect(fileRefusal(png, { accept: " , " })).toBeNull();
    expect(fileRefusal(png, { accept: "" })).toBeNull();
  });
});

describe("parseCsv", () => {
  test("keeps quoted commas and quotes", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n1,2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", "2"],
    ]);
  });

  test("picks the semicolon when the header has more of them", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a;b,c,d\n1;2")).toEqual([["a;b", "c", "d"], ["1;2"]]);
    expect(parseCsv("a;b,c\n1;2")).toEqual([["a;b", "c"], ["1;2"]]);
  });

  test("skips blank lines", () => {
    expect(parseCsv("a;b\n\n1;2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv(",x\ny")).toEqual([["", "x"], ["y"]]);
  });

  test("a preview keeps the first rows and counts every row", () => {
    expect(csvPreview("h\n1\n2\n3", 2)).toEqual({ rows: [["h"], ["1"]], total: 4 });
  });

  test("reads CRLF and CR line ends", () => {
    expect(parseCsv("a,b\r\n1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("stops at the row limit and defaults to twenty rows", () => {
    expect(parseCsv("h\n1\n2\n3", 2)).toEqual([["h"], ["1"]]);
    expect(parseCsv("h\n1\n2", 3)).toEqual([["h"], ["1"], ["2"]]);
    const many = Array.from({ length: 30 }, (_, index) => String(index)).join("\n");
    expect(parseCsv(many)).toHaveLength(20);
    expect(parseCsv(`${many}\n`)).toHaveLength(20);
  });

  test("an empty text has no rows, a trailing separator keeps the empty cell", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,")).toEqual([["a", ""]]);
    expect(parseCsv('"a"')).toEqual([["a"]]);
  });
});

describe("formatBytes", () => {
  test("bytes stay whole, larger units show one decimal below ten", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(-5, "en")).toBe("0 B");
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1_023, "en")).toBe("1,023 B");
    expect(formatBytes(1_024, "en")).toBe("1 KB");
    expect(formatBytes(1_536, "en")).toBe("1.5 KB");
    expect(formatBytes(10_200, "en")).toBe("10 KB");
    expect(formatBytes(10_752, "en")).toBe("11 KB");
    expect(formatBytes(1.5, "en")).toBe("2 B");
    expect(formatBytes(18_400, "de")).toBe("18 KB");
    expect(formatBytes(5 * 1024 * 1024, "de")).toBe("5 MB");
    expect(formatBytes(1_300_000, "de")).toBe("1,2 MB");
    expect(formatBytes(1_300_000, "en")).toBe("1.2 MB");
    expect(formatBytes(3.4 * 1024 ** 3, "en-US")).toBe("3.4 GB");
    expect(formatBytes(42 * 1024 ** 4, "en-US")).toBe("43,008 GB");
  });
});
