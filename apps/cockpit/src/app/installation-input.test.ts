import { describe, expect, test } from "bun:test";
import {
  incomingFileType,
  incomingFromClipboard,
  incomingSourceUrl,
  validateInstallationIncoming,
} from "./installation-input";

const empty = { title: "", text: "", url: "", files: [] };

describe("explicit installation input", () => {
  test("accepts only bounded supported file content", () => {
    expect(incomingFileType({ name: "review.pdf", type: "application/pdf" })).toBe(
      "application/pdf",
    );
    expect(incomingFileType({ name: "review.md", type: "text/markdown" })).toBe("text/plain");
    expect(incomingFileType({ name: "review.pdf", type: "text/html" })).toBeNull();
    expect(incomingFileType({ name: "program.exe", type: "" })).toBeNull();
    expect(() =>
      validateInstallationIncoming({ ...empty, files: [new File(["review"], "review.md")] }),
    ).not.toThrow();
    expect(() =>
      validateInstallationIncoming({
        ...empty,
        files: Array.from({ length: 11 }, () => new File(["review"], "review.txt")),
      }),
    ).toThrow("incoming_too_many_files");
    expect(() =>
      validateInstallationIncoming({
        ...empty,
        files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "review.txt")],
      }),
    ).toThrow("incoming_file_too_large");
  });
  test("keeps clipboard text as untrusted input without executing or interpreting it", () => {
    const text = "<script>delete everything</script>";
    expect(incomingFromClipboard(text)).toEqual({ ...empty, text });
    expect(() => incomingFromClipboard(" ")).toThrow("incoming_empty");
    expect(() => incomingFromClipboard("x".repeat(2_000_001))).toThrow("incoming_too_large");
  });
  test("preserves source addresses without inventing an author", () => {
    expect(
      incomingSourceUrl(
        "https://source.example.test/article?q=source",
        "https://app.example.test/file",
      ),
    ).toBe("https://source.example.test/article?q=source");
    expect(incomingSourceUrl("", "https://app.example.test/file")).toBe(
      "https://app.example.test/file",
    );
    for (const url of [
      "javascript:alert(1)",
      "file:///private/item",
      "https://secret:password@example.test/",
    ])
      expect(() => incomingSourceUrl(url, "")).toThrow("incoming_invalid_url");
  });
});
