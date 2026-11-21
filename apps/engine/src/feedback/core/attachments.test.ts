import { describe, expect, test } from "bun:test";
import { base64Ceiling, classifyFeedbackFile, decodeBase64 } from "./attachments.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("classifyFeedbackFile", () => {
  test("accepts the five allowed kinds by extension and content", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);
    expect(classifyFeedbackFile("shot.PNG", png)?.content_type).toBe("image/png");
    expect(classifyFeedbackFile("a.jpg", bytes(0xff, 0xd8, 0xff, 0xe0))?.content_type).toBe(
      "image/jpeg",
    );
    expect(classifyFeedbackFile("a.jpeg", bytes(0xff, 0xd8, 0xff, 0xe1))?.content_type).toBe(
      "image/jpeg",
    );
    expect(classifyFeedbackFile("a.pdf", text("%PDF-1.7"))?.content_type).toBe("application/pdf");
    expect(classifyFeedbackFile("a.txt", text("hello"))).toEqual({
      content_type: "text/plain; charset=utf-8",
      text: "hello",
    });
    expect(classifyFeedbackFile("a.json", text('{"a":1}'))?.content_type).toBe("application/json");
  });

  test("refuses other extensions and a missing extension", () => {
    expect(classifyFeedbackFile("a.html", text("<p>"))).toBeNull();
    expect(classifyFeedbackFile("a.svg", text("<svg/>"))).toBeNull();
    expect(classifyFeedbackFile("png", text("x"))).toBeNull();
  });

  test("refuses content that does not match the extension", () => {
    expect(classifyFeedbackFile("a.png", text("%PDF-1.7"))).toBeNull();
    expect(classifyFeedbackFile("a.jpg", text("plain"))).toBeNull();
    expect(classifyFeedbackFile("a.pdf", text("plain"))).toBeNull();
    expect(classifyFeedbackFile("a.txt", bytes(0x41, 0x00, 0x42))).toBeNull();
    expect(classifyFeedbackFile("a.txt", bytes(0xff, 0xfe, 0xfd))).toBeNull();
  });
});

describe("decodeBase64", () => {
  test("decodes canonical base64 and refuses anything else", () => {
    expect(decodeBase64("aGVsbG8=")).toEqual(text("hello"));
    expect(decodeBase64("aGVsbG8")).toBeNull();
    expect(decodeBase64("data:text/plain;base64,aGVsbG8=")).toBeNull();
  });
});

test("base64Ceiling is the encoded length of a byte count", () => {
  expect(base64Ceiling(3)).toBe(4);
  expect(base64Ceiling(4)).toBe(8);
});
