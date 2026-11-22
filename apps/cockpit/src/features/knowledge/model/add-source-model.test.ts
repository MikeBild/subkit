import { describe, expect, test } from "bun:test";
import {
  addModeOf,
  addSourceReady,
  filePreview,
  isSourceUrl,
  previewsAsText,
  sourceFileProblem,
} from "@/features/knowledge/model/add-source-model";
import { MAX_FILE } from "@/features/knowledge/model/knowledge";

describe("adding a source", () => {
  test("an address needs a scheme and a host with a dot", () => {
    expect(isSourceUrl(" https://docs.example.com ")).toBe(true);
    expect(isSourceUrl("http://a.b")).toBe(true);
    expect(isSourceUrl("https://")).toBe(false);
    expect(isSourceUrl("ftp://docs.example.com")).toBe(false);
    expect(isSourceUrl("https://localhost")).toBe(false);
  });

  test("only the three known modes are accepted", () => {
    expect(addModeOf("file")).toBe("file");
    expect(addModeOf("api")).toBeUndefined();
  });

  test("each mode is ready only with its own input", () => {
    const draft = { url: "https://", hasFile: false, name: "", text: "" };
    expect(addSourceReady({ ...draft, mode: "url" })).toBe(false);
    expect(addSourceReady({ ...draft, mode: "url", url: "https://docs.example.com" })).toBe(true);
    expect(addSourceReady({ ...draft, mode: "file" })).toBe(false);
    expect(addSourceReady({ ...draft, mode: "file", hasFile: true })).toBe(true);
    expect(addSourceReady({ ...draft, mode: "text", name: "FAQ", text: "  " })).toBe(false);
    expect(addSourceReady({ ...draft, mode: "text", name: " ", text: "x" })).toBe(false);
    expect(addSourceReady({ ...draft, mode: "text", name: "FAQ", text: "x" })).toBe(true);
  });

  test("a file must have a supported extension and fit the size limit", () => {
    expect(sourceFileProblem("handbuch.PDF", 10)).toBeNull();
    expect(sourceFileProblem("bild.png", 10)).toBe("unsupported");
    expect(sourceFileProblem("gross.md", MAX_FILE + 1)).toBe("tooBig");
    expect(sourceFileProblem("genau.md", MAX_FILE)).toBeNull();
  });

  test("only text formats are read for a preview", () => {
    expect(previewsAsText("a.md")).toBe(true);
    expect(previewsAsText("a.html")).toBe(true);
    expect(previewsAsText("a.pdf")).toBe(false);
    expect(previewsAsText("a.docx")).toBe(false);
  });

  test("the preview depends on the format and stays short", () => {
    expect(filePreview("a.pdf", null)).toEqual({ kind: "none" });
    expect(filePreview("a.md", "x".repeat(5000))).toEqual({
      kind: "markdown",
      text: "x".repeat(4000),
    });
    const csv = filePreview("a.csv", Array.from({ length: 10 }, (_, i) => `${i},b`).join("\n"));
    expect(csv.kind === "table" && csv.rows.length).toBe(6);
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const code = filePreview("a.json", lines);
    expect(code).toMatchObject({ kind: "code", lang: "json" });
    expect(code.kind === "code" && code.code.split("\n").length).toBe(12);
    expect(filePreview("a.html", "<p/>")).toMatchObject({ lang: "xml" });
    expect(filePreview("a.txt", "x")).toMatchObject({ lang: "text" });
  });
});
