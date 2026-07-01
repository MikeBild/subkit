// Unit tests for the local-path preprocessor. Text-like local paths
// are read into prompt context; binary paths are uploaded as files.
//
// - `extractCandidatePaths` — pure regex + sanitization. No I/O.
//   Pins the regression where a `.md` directory component (e.g.
//   `/Users/me/ocpp.md/docs/x.md`) used to break path detection, and
//   the paste-artifact regression where trailing prose (", then …" /
//   " in sk") would be glued onto the path token.
//
// - `autoUploadLocalPaths` — exercises the orchestrator with a real
//   temp file and a fake EngineClient.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineClient } from "../engine-client.ts";
import {
  autoUploadLocalPaths,
  extractCandidatePaths,
  inferLocalPathMode,
} from "./path-preprocessor.ts";

describe("extractCandidatePaths", () => {
  test("extracts a bare absolute path from a natural-language prompt", () => {
    const out = extractCandidatePaths("create a knowledge source from /tmp/x.md");
    expect(out).toHaveLength(1);
    expect(out[0]?.cleaned).toBe("/tmp/x.md");
  });

  test("preserves the .md file extension when a directory in the path also ends in .md", () => {
    // Regression: earlier slash-path handling
    // would mangle this path into `OCPP-2.0.1.` or `OCPP-2.0.1` after
    // paste artifacts. The extractor must keep the file suffix intact.
    const path = "/Users/me/ocpp.md/docs/OCPP-2.0.1.md";
    const out = extractCandidatePaths(`ingest ${path} please`);
    expect(out).toHaveLength(1);
    expect(out[0]?.cleaned).toBe(path);
  });

  test("strips trailing punctuation glued by prose", () => {
    const out = extractCandidatePaths("upload /tmp/x.md, then ingest it.");
    expect(out).toHaveLength(1);
    expect(out[0]?.cleaned).toBe("/tmp/x.md");
  });

  test("strips trailing dot from sentence-ending paths", () => {
    const out = extractCandidatePaths("the file lives at /tmp/x.md.");
    expect(out).toHaveLength(1);
    expect(out[0]?.cleaned).toBe("/tmp/x.md");
  });

  test("sanitizes invisible Unicode in pasted paths", () => {
    const raw = "/tmp/​file.md";
    const out = extractCandidatePaths(`use ${raw} here`);
    expect(out).toHaveLength(1);
    expect(out[0]?.cleaned).toBe("/tmp/file.md");
  });

  test("extracts multiple paths in one prompt, left to right", () => {
    const out = extractCandidatePaths("merge /tmp/a.md and /tmp/b.md into one");
    expect(out.map((c) => c.cleaned)).toEqual(["/tmp/a.md", "/tmp/b.md"]);
    expect(out[0]?.start).toBeLessThan(out[1]?.start ?? -1);
  });

  test("recognises home-relative and dot-relative paths", () => {
    const out = extractCandidatePaths("read ~/notes/foo.md and ./local.md");
    expect(out.map((c) => c.cleaned)).toEqual(["~/notes/foo.md", "./local.md"]);
  });

  test("recognises quoted paths with spaces", () => {
    const out = extractCandidatePaths('ingest "/tmp/invoice draft.md" now');
    expect(out[0]?.raw).toBe('"/tmp/invoice draft.md"');
    expect(out[0]?.cleaned).toBe("/tmp/invoice draft.md");
  });

  test("recognises shell-escaped spaces", () => {
    const out = extractCandidatePaths("ingest /tmp/invoice\\ draft.md now");
    expect(out[0]?.raw).toBe("/tmp/invoice\\ draft.md");
    expect(out[0]?.cleaned).toBe("/tmp/invoice draft.md");
  });

  test("recognises file URLs from terminal drag/drop", () => {
    const out = extractCandidatePaths("ingest file:///tmp/invoice%20draft.md now");
    expect(out[0]?.raw).toBe("file:///tmp/invoice%20draft.md");
    expect(out[0]?.cleaned).toBe("/tmp/invoice draft.md");
  });

  test("returns no candidates for messages without paths", () => {
    expect(extractCandidatePaths("list my workflows")).toHaveLength(0);
  });

  test("does not glue an in-prose word onto the path", () => {
    // The error reported from path handling showed " in sk" being
    // treated as part of the path after a paste. The path regex stops
    // at whitespace, so this can't happen in the preprocessor.
    const out = extractCandidatePaths("use /Users/me/foo.md in sk");
    expect(out.map((c) => c.cleaned)).toEqual(["/Users/me/foo.md"]);
  });
});

describe("autoUploadLocalPaths", () => {
  function makeTempFile(name: string, contents = "hello"): string {
    const dir = mkdtempSync(join(tmpdir(), "sk-path-pre-"));
    const p = join(dir, name);
    writeFileSync(p, contents, "utf8");
    return p;
  }

  function fakeClient(opts: { fid?: string } = {}): {
    client: EngineClient;
    uploads: Array<{ filename: string }>;
    links: Array<{ file_id: string; resource_id: string }>;
  } {
    const uploads: Array<{ filename: string }> = [];
    const links: Array<{ file_id: string; resource_id: string }> = [];
    const fid = opts.fid ?? "fid_00000000-0000-0000-0000-000000000001";
    const client = {
      async uploadInline(file: { filename: string }) {
        uploads.push({ filename: file.filename });
        return {
          id: fid,
          filename: file.filename,
          content_type: "text/markdown",
          size_bytes: 5,
          sha256: "x",
          created_at: "2024-11-14T22:13:20.000Z", // FROZEN_NOW
        };
      },
      async linkFile(file_id: string, link: { resource_id: string }) {
        links.push({ file_id, resource_id: link.resource_id });
        return { id: "fl_1", file_id, resource_id: link.resource_id };
      },
    } as unknown as EngineClient;
    return { client, uploads, links };
  }

  test("infers knowledge-source wording as upload mode", () => {
    expect(inferLocalPathMode("ingest /tmp/doc.md as knowledge source")).toBe("knowledge_source");
    expect(inferLocalPathMode("render /tmp/doc.md with render-upload-slides")).toBe(
      "workflow_input",
    );
  });

  test("reads a single text path into prompt context without uploading", async () => {
    const path = makeTempFile("doc.md", "# Deck\n\nHello");
    const { client, uploads, links } = fakeClient();
    const result = await autoUploadLocalPaths(
      `render ${path} with render-upload-slides`,
      client,
      "/",
      "conv-1",
    );
    expect(uploads).toHaveLength(0);
    expect(links).toHaveLength(0);
    expect(result.uploaded).toHaveLength(0);
    expect(result.inlined).toHaveLength(1);
    expect(result.rewritten).toContain(path);
    expect(result.rewritten).toContain("## Local file contents: doc.md");
    expect(result.rewritten).toContain("# Deck");
  });

  test("uploads a text path for knowledge-source intent", async () => {
    const path = makeTempFile("doc.md", "# Knowledge\n\nHello");
    const { client, uploads, links } = fakeClient();
    const result = await autoUploadLocalPaths(
      `ingest ${path} as knowledge source`,
      client,
      "/",
      "conv-1",
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.filename).toBe("doc.md");
    expect(links).toHaveLength(1);
    expect(result.inlined).toHaveLength(0);
    expect(result.uploaded).toHaveLength(1);
    expect(result.rewritten).toContain("@file:fid_00000000-0000-0000-0000-000000000001");
    expect(result.rewritten).not.toContain("## Local file contents");
  });

  test("silently skips non-existent paths and leaves them in the prompt", async () => {
    const { client, uploads } = fakeClient();
    const result = await autoUploadLocalPaths(
      "look at /tmp/definitely-not-a-real-file-xyz123.md please",
      client,
      "/",
      "conv-1",
    );
    expect(uploads).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("not_found");
    expect(result.rewritten).toContain("/tmp/definitely-not-a-real-file-xyz123.md");
  });

  test("reads multiple text paths and appends each content block", async () => {
    const a = makeTempFile("a.md", "aaa");
    const b = makeTempFile("b.md", "bbb");
    const { client } = fakeClient();
    const result = await autoUploadLocalPaths(`merge ${a} and ${b}`, client, "/", "c-1");
    expect(result.uploaded).toHaveLength(0);
    expect(result.inlined).toHaveLength(2);
    expect(result.rewritten).toContain("## Local file contents: a.md");
    expect(result.rewritten).toContain("aaa");
    expect(result.rewritten).toContain("## Local file contents: b.md");
    expect(result.rewritten).toContain("bbb");
  });

  test("reads a quoted text path with spaces on submit", async () => {
    const path = makeTempFile("invoice draft.md", "invoice text");
    const { client } = fakeClient();
    const result = await autoUploadLocalPaths(`render "${path}"`, client, "/", "conv-1");
    expect(result.inlined).toHaveLength(1);
    expect(result.uploaded).toHaveLength(0);
    expect(result.rewritten).toContain("invoice text");
  });

  test("uploads a binary path and rewrites it to @file:fid_…", async () => {
    const path = makeTempFile("image.png", "not really png");
    const { client, uploads, links } = fakeClient();
    const result = await autoUploadLocalPaths(`attach ${path}`, client, "/", "conv-1");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.filename).toBe("image.png");
    expect(links).toHaveLength(1);
    expect(result.inlined).toHaveLength(0);
    expect(result.uploaded).toHaveLength(1);
    expect(result.rewritten).toContain("@file:fid_00000000-0000-0000-0000-000000000001");
    expect(result.rewritten).not.toContain(path);
  });

  test("returns the input unchanged when no paths are present", async () => {
    const { client, uploads } = fakeClient();
    const result = await autoUploadLocalPaths("list my workflows", client, "/", "c");
    expect(uploads).toHaveLength(0);
    expect(result.rewritten).toBe("list my workflows");
    expect(result.inlined).toHaveLength(0);
    expect(result.uploaded).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("upload failure is reported in skipped, prompt left unchanged", async () => {
    const path = makeTempFile("blob.pdf");
    const client = {
      async uploadInline() {
        throw new Error("network blew up");
      },
      async linkFile() {
        return { id: "fl", file_id: "x", resource_id: "y" };
      },
    } as unknown as EngineClient;
    const result = await autoUploadLocalPaths(`ingest ${path}`, client, "/", "c");
    expect(result.uploaded).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("upload_failed");
    expect(result.skipped[0]?.detail).toContain("network blew up");
    expect(result.rewritten).toContain(path);
  });
});
