import { describe, expect, test } from "bun:test";
import { checkIntakeFile, intakeFileBody } from "./intake-file.ts";

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "utf8")] : part)),
  );

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

describe("checkIntakeFile", () => {
  test("binary files are accepted only when their bytes match the declared type", () => {
    expect(checkIntakeFile("application/pdf", bytes("%PDF-1.7\n"))).toEqual({
      ok: true,
      content_type: "application/pdf",
      text: null,
    });
    expect(checkIntakeFile("image/png", bytes(PNG)).ok).toBe(true);
    expect(checkIntakeFile("image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0])).ok).toBe(true);
    expect(checkIntakeFile("image/gif", bytes("GIF89a")).ok).toBe(true);
    expect(checkIntakeFile("image/webp", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")).ok).toBe(true);
    expect(checkIntakeFile("image/png", bytes("%PDF-1.7"))).toEqual({
      ok: false,
      reason: "content_type_mismatch",
    });
  });

  test("text files must be UTF-8 and are returned as text", () => {
    expect(checkIntakeFile("text/csv; charset=utf-8", bytes("a,b\n1,2\n"))).toEqual({
      ok: true,
      content_type: "text/csv",
      text: "a,b\n1,2\n",
    });
    expect(checkIntakeFile("text/plain", bytes([0xff, 0xfe, 0x00])).ok).toBe(false);
  });

  test("JSON must parse", () => {
    expect(checkIntakeFile("application/json", bytes('{"a":1}')).ok).toBe(true);
    expect(checkIntakeFile("application/json", bytes("{nope")).ok).toBe(false);
  });

  test("active content is refused, also when it pretends to be text", () => {
    expect(checkIntakeFile("text/html", bytes("<p>x</p>"))).toEqual({
      ok: false,
      reason: "unsupported_file_type",
    });
    expect(checkIntakeFile("image/svg+xml", bytes("<svg/>")).ok).toBe(false);
    expect(checkIntakeFile("text/plain", bytes("<!DOCTYPE html><html></html>"))).toEqual({
      ok: false,
      reason: "content_type_mismatch",
    });
    expect(checkIntakeFile("text/markdown", bytes("  <svg onload=x>")).ok).toBe(false);
  });

  test("unknown types are refused", () => {
    expect(checkIntakeFile("application/zip", bytes("PK")).ok).toBe(false);
  });
});

describe("intakeFileBody", () => {
  const file = { filename: "q3.pdf", content_type: "application/pdf" as const, size_bytes: 2048 };

  test("text files carry their text", () => {
    expect(intakeFileBody({ ...file, content_type: "text/csv" }, "a,b")).toBe("a,b");
  });

  test("binary files are named in one line", () => {
    expect(intakeFileBody(file, null)).toBe("q3.pdf (application/pdf, 2048 bytes)");
  });
});
