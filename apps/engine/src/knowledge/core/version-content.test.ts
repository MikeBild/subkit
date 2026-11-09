import { expect, test } from "bun:test";
import {
  knowledgeVersionContent,
  knowledgeVersionDocuments,
  knowledgeVersionUpload,
  restoredNote,
} from "./version-content.ts";

test("document versions retain upload identity, remove NULs and restore upload facts", () => {
  const document = knowledgeVersionContent({
    source_type: "file_upload",
    upload: { filename: "a.txt" },
    text: "a\u0000b\u0000",
  });
  expect(document).toEqual({ kind: "document", filename: "a.txt", mime: null, text: "ab" });
  expect(knowledgeVersionUpload(document)).toEqual({
    filename: "a.txt",
    mime: null,
    text: "ab",
    parsed_chunks: null,
  });
  expect(knowledgeVersionDocuments(document)).toEqual([{ path: "a.txt", content: "ab" }]);
  expect(
    knowledgeVersionContent({
      source_type: "url",
      upload: { filename: "a.html", mime: "text/html" },
      text: "ok",
    }),
  ).toEqual({ kind: "document", filename: "a.html", mime: "text/html", text: "ok" });
  expect(restoredNote(42)).toBe("restored from v42");
});

test("bundle versions preserve supplied chunks with filename fallback without mutating them", () => {
  const chunks = [{ path: "a.md", content: "A" }, { content: "B" }];
  const before = structuredClone(chunks);
  const bundle = knowledgeVersionContent({
    source_type: "bundle",
    upload: { filename: "bundle.json" },
    text: "ignored",
    parsed_chunks: chunks,
  });
  expect(bundle).toEqual({
    kind: "bundle",
    filename: "bundle.json",
    files: [
      { path: "a.md", content: "A" },
      { path: "bundle.json", content: "B" },
    ],
  });
  expect(knowledgeVersionDocuments(bundle)).toEqual([
    { path: "a.md", content: "A" },
    { path: "bundle.json", content: "B" },
  ]);
  const restored = knowledgeVersionUpload(bundle);
  expect(restored.filename).toBe("bundle.json");
  expect(restored.mime).toBe("application/json");
  expect(restored.parsed_chunks?.map((chunk) => chunk.content)).toEqual(["A", "B"]);
  expect(restored.text).toContain("a.md");
  expect(chunks).toEqual(before);
  expect(
    knowledgeVersionContent({
      source_type: "bundle",
      upload: { filename: "empty" },
      text: "ignored",
    }),
  ).toEqual({ kind: "bundle", filename: "empty", files: [] });
});
