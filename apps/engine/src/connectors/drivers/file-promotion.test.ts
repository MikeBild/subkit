// Promotion-rule tests: which HTTP response bodies become engine-managed
// files instead of being UTF-8-decoded. Pure decision matrix, no I/O.

import { describe, expect, test } from "bun:test";
import {
  filenameFromResponse,
  PROMOTE_SIZE_THRESHOLD_BYTES,
  shouldPromoteToFile,
} from "./file-promotion.ts";

const PDF_BYTES = Buffer.from("%PDF-1.7\n\x00\x01binary");
const TEXT_BYTES = Buffer.from("hello plain text");
const JSON_BYTES = Buffer.from(JSON.stringify({ ok: true, items: [1, 2, 3] }));

function promote(over: Partial<Parameters<typeof shouldPromoteToFile>[0]>): boolean {
  return shouldPromoteToFile({
    status: 200,
    content_type: null,
    content_disposition: null,
    bytes: TEXT_BYTES,
    ...over,
  });
}

describe("shouldPromoteToFile", () => {
  test("Content-Disposition attachment always promotes", () => {
    expect(promote({ content_disposition: 'attachment; filename="r.pdf"' })).toBe(true);
    expect(promote({ content_disposition: "ATTACHMENT" })).toBe(true);
  });

  test("inline disposition does not promote by itself", () => {
    expect(promote({ content_disposition: "inline", content_type: "text/plain" })).toBe(false);
  });

  test("non-2xx never promotes, even with attachment disposition", () => {
    expect(promote({ status: 404, content_disposition: "attachment" })).toBe(false);
    expect(promote({ status: 301, content_disposition: "attachment" })).toBe(false);
  });

  test("non-text content types promote (pdf, image, zip)", () => {
    expect(promote({ content_type: "application/pdf", bytes: PDF_BYTES })).toBe(true);
    expect(promote({ content_type: "image/png", bytes: PDF_BYTES })).toBe(true);
    expect(promote({ content_type: "application/zip", bytes: PDF_BYTES })).toBe(true);
  });

  test("text content types do not promote", () => {
    expect(promote({ content_type: "text/csv" })).toBe(false);
    expect(promote({ content_type: "application/json", bytes: JSON_BYTES })).toBe(false);
    expect(promote({ content_type: "text/html; charset=utf-8" })).toBe(false);
  });

  test("octet-stream with JSON-shaped bytes stays on the parse path (mislabeled-JSON guard)", () => {
    expect(promote({ content_type: "application/octet-stream", bytes: JSON_BYTES })).toBe(false);
  });

  test("octet-stream with binary bytes promotes", () => {
    expect(promote({ content_type: "application/octet-stream", bytes: PDF_BYTES })).toBe(true);
  });

  test("unknown content type falls to the NUL sniff", () => {
    expect(promote({ content_type: null, bytes: PDF_BYTES })).toBe(true);
    expect(promote({ content_type: "", bytes: TEXT_BYTES })).toBe(false);
  });

  test("size threshold promotes oversized text", () => {
    const big = Buffer.alloc(PROMOTE_SIZE_THRESHOLD_BYTES + 1, 65);
    expect(promote({ content_type: "text/plain", bytes: big })).toBe(false); // text type is trusted
    expect(promote({ content_type: null, bytes: big })).toBe(true); // unknown + oversized
    const atLimit = Buffer.alloc(PROMOTE_SIZE_THRESHOLD_BYTES, 65);
    expect(promote({ content_type: null, bytes: atLimit })).toBe(false); // boundary: not over
  });
});

describe("filenameFromResponse", () => {
  const base = {
    url: "https://api.example.com/v1/export/report.pdf",
    content_type: null,
    step_id: "fetch",
  };

  test("RFC 8187 filename*= wins over filename=", () => {
    expect(
      filenameFromResponse({
        ...base,
        content_disposition: `attachment; filename="fallback.pdf"; filename*=UTF-8''J%C3%A4hres%20Report.pdf`,
      }),
    ).toBe("Jähres Report.pdf");
  });

  test("quoted filename= parameter", () => {
    expect(
      filenameFromResponse({ ...base, content_disposition: 'attachment; filename="q3.xlsx"' }),
    ).toBe("q3.xlsx");
  });

  test("unquoted filename= token", () => {
    expect(
      filenameFromResponse({ ...base, content_disposition: "attachment; filename=raw.zip" }),
    ).toBe("raw.zip");
  });

  test("path traversal in disposition is stripped to the basename", () => {
    expect(
      filenameFromResponse({
        ...base,
        content_disposition: 'attachment; filename="../../etc/passwd.pdf"',
      }),
    ).toBe("passwd.pdf");
  });

  test("falls back to the URL's last path segment when it carries an extension", () => {
    expect(filenameFromResponse({ ...base, content_disposition: null })).toBe("report.pdf");
  });

  test("extension-less URL segment falls through to the typed step fallback", () => {
    expect(
      filenameFromResponse({
        content_disposition: null,
        url: "https://api.example.com/v1/download",
        content_type: "application/pdf",
        step_id: "fetch",
      }),
    ).toBe("fetch-response.pdf");
  });

  test("unknown content type falls back to .bin", () => {
    expect(
      filenameFromResponse({
        content_disposition: null,
        url: "https://api.example.com/v1/download",
        content_type: "application/x-custom",
        step_id: "fetch",
      }),
    ).toBe("fetch-response.bin");
  });
});
