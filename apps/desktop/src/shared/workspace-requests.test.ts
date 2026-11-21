import { describe, expect, test } from "bun:test";
import {
  contentTypeOf,
  headerSafeName,
  inlineFileBody,
  intakeFileBody,
  isCsrfRejection,
  multipartSource,
  parseCreatedId,
  parseCsrfToken,
} from "./workspace-requests.ts";

describe("answers", () => {
  test("reads the CSRF token and the created id defensively", () => {
    expect(parseCsrfToken({ csrf_token: "abc" })).toBe("abc");
    expect(parseCsrfToken({ csrf_token: "" })).toBeNull();
    expect(parseCsrfToken(null)).toBeNull();
    expect(parseCreatedId({ id: "7d1d0c8e-2b6b-4b1a-9b8a-111111111111" })).toBe(
      "7d1d0c8e-2b6b-4b1a-9b8a-111111111111",
    );
    expect(parseCreatedId({ id: "../x" })).toBeNull();
    expect(parseCreatedId([])).toBeNull();
  });

  test("renews the token only for a CSRF refusal", () => {
    expect(isCsrfRejection(403, { code: "csrf_rejected" })).toBe(true);
    expect(isCsrfRejection(403, { code: "forbidden" })).toBe(false);
    expect(isCsrfRejection(401, { code: "csrf_rejected" })).toBe(false);
  });
});

describe("request bodies", () => {
  test("inline file upload as base64", () => {
    expect(inlineFileBody("a.txt", "text/plain", new TextEncoder().encode("hi"))).toEqual({
      filename: "a.txt",
      content_type: "text/plain",
      content_base64: "aGk=",
    });
  });

  test("a file for the inbox carries its request id and capture time", () => {
    const now = new Date("2026-11-21T10:00:00.000Z");
    expect(
      intakeFileBody("scan.pdf", "application/pdf", new TextEncoder().encode("hi"), now, "r1"),
    ).toEqual({
      client_request_id: "r1",
      captured_at: "2026-11-21T10:00:00.000Z",
      filename: "scan.pdf",
      content_type: "application/pdf",
      content_base64: "aGk=",
    });
  });

  test("content type from the extension, octet-stream otherwise", () => {
    expect(contentTypeOf("Plan.MD")).toBe("text/markdown");
    expect(contentTypeOf("x.pdf")).toBe("application/pdf");
    expect(contentTypeOf("README")).toBe("application/octet-stream");
  });

  test("multipart body carries metadata and the file with a safe name", () => {
    const body = multipartSource(
      "b0",
      {
        name: 'Hand"buch\r\n.md',
        contentType: "text/markdown",
        bytes: new TextEncoder().encode("# H"),
      },
      { name: "Handbuch" },
    );
    const text = new TextDecoder().decode(body);
    expect(text).toContain('name="metadata"\r\n\r\n{"name":"Handbuch"}\r\n--b0\r\n');
    expect(text).toContain('filename="Hand_buch__.md"\r\nContent-Type: text/markdown\r\n\r\n# H');
    expect(text.endsWith("\r\n--b0--\r\n")).toBe(true);
    expect(headerSafeName("")).toBe("file");
  });
});
