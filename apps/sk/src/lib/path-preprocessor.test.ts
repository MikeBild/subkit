// Unit tests for the auto-upload preprocessor that turns absolute
// local paths in chat prompts into `@file:fid_…` mentions before the
// message reaches the agent. Two surfaces under test:
//
// - `extractCandidatePaths` — pure regex + sanitization. No I/O.
//   Pins the regression where a `.md` directory component (e.g.
//   `/Users/me/ocpp.md/docs/x.md`) used to break path detection, and
//   the paste-artifact regression where trailing prose (", then …" /
//   " in sk") would be glued onto the path token.
//
// - `autoUploadLocalPaths` — exercises the orchestrator with a real
//   temp file and a fake EngineClient. Verifies that uploaded paths
//   get replaced by `@file:fid_…` mentions and missing paths are
//   skipped silently.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineClient } from "../engine-client.ts";
import { autoUploadLocalPaths, extractCandidatePaths } from "./path-preprocessor.ts";

describe("extractCandidatePaths", () => {
  test("extracts a bare absolute path from a natural-language prompt", () => {
    const out = extractCandidatePaths("create a knowledge source from /tmp/x.md");
    expect(out).toHaveLength(1);
    expect(out[0]?.cleaned).toBe("/tmp/x.md");
  });

  test("preserves the .md file extension when a directory in the path also ends in .md", () => {
    // Regression: the existing `/knowledge` / `/attach` slash handlers
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

  test("returns no candidates for messages without paths", () => {
    expect(extractCandidatePaths("list my workflows")).toHaveLength(0);
  });

  test("does not glue an in-prose word onto the path", () => {
    // The error reported from the slash-handler showed " in sk" being
    // treated as part of the path after a paste. The path regex stops
    // at whitespace, so this can't happen in the preprocessor.
    const out = extractCandidatePaths("/attach /Users/me/foo.md in sk");
    expect(out.map((c) => c.cleaned)).toEqual(["/attach", "/Users/me/foo.md"]);
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
          created_at: new Date().toISOString(),
        };
      },
      async linkFile(file_id: string, link: { resource_id: string }) {
        links.push({ file_id, resource_id: link.resource_id });
        return { id: "fl_1", file_id, resource_id: link.resource_id };
      },
    } as unknown as EngineClient;
    return { client, uploads, links };
  }

  test("rewrites a single absolute path to @file:fid_… and uploads once", async () => {
    const path = makeTempFile("doc.md");
    const { client, uploads, links } = fakeClient();
    const result = await autoUploadLocalPaths(`ingest ${path} as knowledge`, client, "/", "conv-1");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.filename).toBe("doc.md");
    expect(links).toHaveLength(1);
    expect(links[0]?.resource_id).toBe("conv-1");
    expect(result.uploaded).toHaveLength(1);
    expect(result.rewritten).toContain("@file:fid_00000000-0000-0000-0000-000000000001");
    expect(result.rewritten).not.toContain(path);
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

  test("uploads multiple paths and rewrites each one", async () => {
    const a = makeTempFile("a.md", "aaa");
    const b = makeTempFile("b.md", "bbb");
    const fids = [
      "fid_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "fid_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ];
    let i = 0;
    const client = {
      async uploadInline(file: { filename: string }) {
        const fid = fids[i++] ?? "fid_00000000-0000-0000-0000-000000000000";
        return {
          id: fid,
          filename: file.filename,
          content_type: "text/markdown",
          size_bytes: 3,
          sha256: "x",
          created_at: new Date().toISOString(),
        };
      },
      async linkFile() {
        return { id: "fl", file_id: "x", resource_id: "y" };
      },
    } as unknown as EngineClient;
    const result = await autoUploadLocalPaths(`merge ${a} and ${b}`, client, "/", "c-1");
    expect(result.uploaded).toHaveLength(2);
    expect(result.rewritten).toContain(`@file:${fids[0]}`);
    expect(result.rewritten).toContain(`@file:${fids[1]}`);
  });

  test("returns the input unchanged when no paths are present", async () => {
    const { client, uploads } = fakeClient();
    const result = await autoUploadLocalPaths("list my workflows", client, "/", "c");
    expect(uploads).toHaveLength(0);
    expect(result.rewritten).toBe("list my workflows");
    expect(result.uploaded).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("upload failure is reported in skipped, prompt left unchanged", async () => {
    const path = makeTempFile("doc.md");
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
