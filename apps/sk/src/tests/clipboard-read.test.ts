// Unit tests for the clipboard classifier. We do NOT shell out in
// tests (that would couple the suite to the host's clipboard); the
// readClipboard path is covered by the E2E suite via a mock.

import { describe, expect, test } from "bun:test";
import { classifyAttachment } from "../repl/clipboard-read.ts";

describe("classifyAttachment: images", () => {
  test("png / jpg / gif / webp / heic are images with the right media type", () => {
    expect(classifyAttachment("/tmp/a.png")).toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    expect(classifyAttachment("/tmp/a.jpg")).toEqual({
      kind: "image",
      mediaType: "image/jpeg",
    });
    expect(classifyAttachment("/tmp/A.JPEG")).toEqual({
      kind: "image",
      mediaType: "image/jpeg",
    });
    expect(classifyAttachment("/tmp/a.gif")).toEqual({
      kind: "image",
      mediaType: "image/gif",
    });
    expect(classifyAttachment("/tmp/a.webp")).toEqual({
      kind: "image",
      mediaType: "image/webp",
    });
    expect(classifyAttachment("/tmp/a.heic")).toEqual({
      kind: "image",
      mediaType: "image/heic",
    });
  });
});

describe("classifyAttachment: docs", () => {
  test("pdf / docx / doc / xlsx / xls / csv / md get media types", () => {
    expect(classifyAttachment("/tmp/a.pdf").mediaType).toBe("application/pdf");
    expect(classifyAttachment("/tmp/a.docx").mediaType).toContain("wordprocessingml");
    expect(classifyAttachment("/tmp/a.doc").mediaType).toBe("application/msword");
    expect(classifyAttachment("/tmp/a.xlsx").mediaType).toContain("spreadsheetml");
    expect(classifyAttachment("/tmp/a.xls").mediaType).toBe("application/vnd.ms-excel");
    expect(classifyAttachment("/tmp/a.csv").mediaType).toBe("text/csv");
    expect(classifyAttachment("/tmp/readme.md").mediaType).toBe("text/markdown");
    expect(classifyAttachment("/tmp/readme.markdown").mediaType).toBe("text/markdown");
  });

  test("everything non-image is kind: `file`", () => {
    expect(classifyAttachment("/tmp/a.pdf").kind).toBe("file");
    expect(classifyAttachment("/tmp/a.docx").kind).toBe("file");
    expect(classifyAttachment("/tmp/a.zip").kind).toBe("file");
  });

  test("unknown extension falls back to octet-stream", () => {
    expect(classifyAttachment("/tmp/a.xyz").mediaType).toBe("application/octet-stream");
  });
});
