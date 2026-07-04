// detectMime() table tests.
//
// Covers common extensions, multi-dot filenames, no-extension default,
// and case-insensitive matching.

import { describe, expect, test } from "bun:test";
import { detectMime, MIME_MAP } from "./mime.ts";

describe("detectMime — common extensions", () => {
  const cases: Array<[string, string]> = [
    ["report.pdf", "application/pdf"],
    ["notes.txt", "text/plain"],
    ["README.md", "text/markdown"],
    ["index.html", "text/html"],
    ["page.htm", "text/html"],
    ["data.json", "application/json"],
    ["table.csv", "text/csv"],
    ["feed.xml", "application/xml"],
    ["photo.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["image.webp", "image/webp"],
  ];

  for (const [filename, expected] of cases) {
    test(`${filename} → ${expected}`, () => {
      expect(detectMime(filename)).toBe(expected);
    });
  }
});

describe("detectMime — case-insensitive extension matching", () => {
  test("PDF uppercase extension → application/pdf", () => {
    expect(detectMime("REPORT.PDF")).toBe("application/pdf");
  });

  test("mixed-case .Pdf → application/pdf", () => {
    expect(detectMime("Report.Pdf")).toBe("application/pdf");
  });

  test("uppercase .TXT → text/plain", () => {
    expect(detectMime("notes.TXT")).toBe("text/plain");
  });

  test("mixed-case .JSON → application/json", () => {
    expect(detectMime("config.JSON")).toBe("application/json");
  });
});

describe("detectMime — multi-dot filenames", () => {
  test("archive.tar.gz uses last extension (.gz) → application/gzip", () => {
    // Last extension wins — the engine's gzip parser recursively
    // extracts the inner payload, so the tar wrapper is its concern.
    expect(detectMime("archive.tar.gz")).toBe("application/gzip");
  });

  test("bundle.zip → application/zip", () => {
    expect(detectMime("bundle.zip")).toBe("application/zip");
  });

  test("report.v2.pdf → application/pdf", () => {
    expect(detectMime("report.v2.pdf")).toBe("application/pdf");
  });

  test("data.min.json → application/json", () => {
    expect(detectMime("data.min.json")).toBe("application/json");
  });
});

describe("detectMime — no extension / unknown extension", () => {
  test("filename with no extension → application/octet-stream", () => {
    expect(detectMime("Makefile")).toBe("application/octet-stream");
  });

  test("hidden file (.gitignore) with no known extension → application/octet-stream", () => {
    expect(detectMime(".gitignore")).toBe("application/octet-stream");
  });

  test("unknown extension .xyz → application/octet-stream", () => {
    expect(detectMime("payload.xyz")).toBe("application/octet-stream");
  });

  test("empty string path → application/octet-stream", () => {
    expect(detectMime("")).toBe("application/octet-stream");
  });
});

describe("detectMime — absolute paths", () => {
  test("/tmp/upload/photo.png → image/png", () => {
    expect(detectMime("/tmp/upload/photo.png")).toBe("image/png");
  });

  test("/Users/admin/report.pdf → application/pdf", () => {
    expect(detectMime("/Users/admin/report.pdf")).toBe("application/pdf");
  });
});

describe("MIME_MAP completeness", () => {
  test("all MIME_MAP keys start with a dot", () => {
    for (const key of Object.keys(MIME_MAP)) {
      expect(key.startsWith("."), `key "${key}" should start with '.'`).toBe(true);
    }
  });

  test("all MIME_MAP keys are lowercase", () => {
    for (const key of Object.keys(MIME_MAP)) {
      expect(key, `key "${key}" should be lowercase`).toBe(key.toLowerCase());
    }
  });
});
