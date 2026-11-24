import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFileDelete } from "../../commands/files.ts";
import {
  EngineClient,
  type FileLinkWire,
  type FileStatsWire,
  type FileWire,
} from "../../engine-client.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeFileRow(overrides: Partial<FileWire> = {}): FileWire {
  return {
    id: "fid_00000000-0000-0000-0000-000000000001",
    status: "ready",
    filename: "test.txt",
    content_type: "text/plain",
    size_bytes: 12,
    sha256: "abc123",
    scan_result: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function makeLinkRow(overrides: Partial<FileLinkWire> = {}): FileLinkWire {
  return {
    id: "link-uuid-1",
    file_id: "fid_00000000-0000-0000-0000-000000000001",
    resource_type: "conversation",
    resource_id: "conv-uuid-1",
    slug: null,
    role: null,
    created_at: NOW,
    ...overrides,
  };
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subkit-files-cmd-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("subkit files list", () => {
  test("returns item array — happy path", async () => {
    const row = makeFileRow();
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: [row], next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const res = await client.listFiles({ limit: 20 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.id).toBe(row.id);
    expect(res.next_cursor).toBeNull();
  });

  test("passes status filter in query string", async () => {
    let capturedUrl = "";
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({ items: [], next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.listFiles({ status: "ready", limit: 10 });
    expect(capturedUrl).toContain("status=ready");
    expect(capturedUrl).toContain("limit=10");
  });

  test("wrong tenant gets 403 → EngineError", async () => {
    const { EngineError } = await import("@cli-core/errors.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_wrong",
      tenant: "t-wrong",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "forbidden", message: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.listFiles()).rejects.toBeInstanceOf(EngineError);
  });
});

describe("subkit files get", () => {
  test("returns file metadata", async () => {
    const row = makeFileRow({ sha256: "deadbeef" });
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () =>
        new Response(JSON.stringify(row), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await client.getFile(row.id);
    expect(result.sha256).toBe("deadbeef");
    expect(result.status).toBe("ready");
  });

  test("404 for unknown id → EngineError status 404", async () => {
    const { EngineError } = await import("@cli-core/errors.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "not_found", message: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    });
    const err = await client.getFile("fid_nonexistent").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as InstanceType<typeof EngineError>).status).toBe(404);
  });
});

describe("subkit files upload — inline path (≤5 MB)", () => {
  test("small file calls uploadInline, returns FileWire", async () => {
    const row = makeFileRow({ size_bytes: 5 });
    let capturedPath = "";
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        capturedPath = String(input);
        return new Response(JSON.stringify(row), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const fp = join(tmpDir, "small.txt");
    writeFileSync(fp, "hello world");

    const { uploadPath } = await import("../../commands/files.ts");
    const result = await uploadPath(client, fp, { quiet: true });

    expect(capturedPath).toContain("/v1/files/inline");
    expect(result.id).toBe(row.id);
  });
});

describe("subkit files download", () => {
  test("streams bytes and returns metadata", async () => {
    const row = makeFileRow({ size_bytes: 5 });
    let callCount = 0;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        const url = String(input);
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify(row), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        expect(url).toContain("/content");
        return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    });

    const dl = await client.downloadFile(row.id);
    expect(dl.filename).toBe("test.txt");
    expect(dl.size_bytes).toBe(5);
    expect(dl.stream).toBeDefined();
  });
});

describe("subkit files delete", () => {
  test("soft-delete returns 204 (no body)", async () => {
    let deletedId = "";
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        deletedId = String(input);
        return new Response(null, { status: 204 });
      },
    });
    await client.deleteFile("fid_00000000-0000-0000-0000-000000000001");
    expect(deletedId).toContain("fid_00000000-0000-0000-0000-000000000001");
  });

  test("delete on wrong tenant gets 403", async () => {
    const { EngineError } = await import("@cli-core/errors.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_wrong",
      tenant: "t-wrong",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "forbidden", message: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.deleteFile("fid_x")).rejects.toBeInstanceOf(EngineError);
  });
});

describe("subkit files link", () => {
  test("links file to conversation resource", async () => {
    const link = makeLinkRow();
    let capturedBody: unknown;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (_input, init) => {
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify(link), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await client.linkFile("fid_00000000-0000-0000-0000-000000000001", {
      resource_type: "conversation",
      resource_id: "conv-uuid-1",
      role: "attachment",
    });
    expect(result.resource_type).toBe("conversation");
    expect((capturedBody as Record<string, unknown>).role).toBe("attachment");
  });

  test("link to unknown resource type is a client-side error", async () => {
    const { parseResourceRef } = await import("../../commands/files.ts");
    expect(() => parseResourceRef("bogus_type:00000000-0000-0000-0000-000000000001")).toThrow(
      /bad resource_type 'bogus_type'/,
    );
    expect(() => parseResourceRef("no-colon-here")).toThrow(/bad resource ref 'no-colon-here'/);
  });
});

describe("subkit files stats", () => {
  test("returns structured aggregate counters", async () => {
    const stats: FileStatsWire = {
      total: 42,
      by_status: { ready: 40, pending: 2 },
      by_size_bucket: { "0-1mb": 30, "1-10mb": 12 },
      dedup_hits: 7,
      scan_verdicts: { clean: 40 },
    };
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () =>
        new Response(JSON.stringify(stats), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await client.getFileStats();
    expect(result.total).toBe(42);
    expect(result.dedup_hits).toBe(7);
    expect(result.by_status.ready).toBe(40);
  });

  test("wrong tenant → 403", async () => {
    const { EngineError } = await import("@cli-core/errors.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "bad-key",
      tenant: "t-other",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "forbidden", message: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.getFileStats()).rejects.toBeInstanceOf(EngineError);
  });
});

describe("subkit files replace, versions and restore", () => {
  test("replace posts inline content to the file's replace route", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          method: String(init?.method),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify(makeFileRow({ filename: "new.txt" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const row = await client.replaceFile("fid_00000000-0000-0000-0000-000000000001", {
      filename: "new.txt",
      content_type: "text/plain",
      content_base64: Buffer.from("next").toString("base64"),
    });
    expect(row.filename).toBe("new.txt");
    expect(calls[0]).toMatchObject({
      url: "http://engine.local/v1/files/fid_00000000-0000-0000-0000-000000000001/replace",
      method: "POST",
      body: { filename: "new.txt", content_base64: Buffer.from("next").toString("base64") },
    });
  });

  test("versions lists current and earlier content newest first", async () => {
    const entry = {
      filename: "test.txt",
      content_type: "text/plain",
      size_bytes: 4,
      sha256: "b",
      restored_from: null,
      uploaded_at: NOW,
      uploaded_by: null,
    };
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            items: [
              { ...entry, version: 2, current: true, replaced_at: null },
              { ...entry, version: 1, current: false, replaced_at: NOW },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const items = await client.listFileVersions("fid_00000000-0000-0000-0000-000000000001");
    expect(items.map((item) => [item.version, item.current])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  test("restore addresses one version and surfaces conflicts", async () => {
    const urls: string[] = [];
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({ code: "duplicate_content", message: "another file has it" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(
      client.restoreFileVersion("fid_00000000-0000-0000-0000-000000000001", 1),
    ).rejects.toMatchObject({ status: 409 });
    expect(urls).toEqual([
      "http://engine.local/v1/files/fid_00000000-0000-0000-0000-000000000001/versions/1/restore",
    ]);
  });
});

describe("subkit files delete confirmation (#511)", () => {
  const FILE_ID = "fid_00000000-0000-0000-0000-000000000001";
  const harness = (isTTY: boolean, confirmAnswer = true) => {
    const calls = { deleted: [] as string[], confirmed: 0, out: "", err: "" };
    const deps = {
      isTTY,
      deleteFile: async (id: string) => {
        calls.deleted.push(id);
      },
      confirm: async () => {
        calls.confirmed++;
        return confirmAnswer;
      },
      writeOut: (text: string) => {
        calls.out += text;
      },
      writeErr: (text: string) => {
        calls.err += text;
      },
    };
    return { calls, deps };
  };

  test("non-interactive without --force refuses and does not delete", async () => {
    const { calls, deps } = harness(false);
    const exitCode = await runFileDelete({ id: FILE_ID, force: false, ...deps });
    expect(exitCode).toBe(2);
    expect(calls.deleted).toEqual([]);
    expect(calls.confirmed).toBe(0);
    expect(calls.err).toContain(`refusing to delete ${FILE_ID} without confirmation`);
    expect(calls.err).toContain("--force");
    expect(calls.out).not.toContain("deleted");
  });

  test("non-interactive with --force deletes", async () => {
    const { calls, deps } = harness(false);
    const exitCode = await runFileDelete({ id: FILE_ID, force: true, ...deps });
    expect(exitCode).toBe(0);
    expect(calls.deleted).toEqual([FILE_ID]);
    expect(calls.out).toContain("deleted");
  });

  test("interactive prompt confirmed deletes", async () => {
    const { calls, deps } = harness(true, true);
    const exitCode = await runFileDelete({ id: FILE_ID, force: false, ...deps });
    expect(exitCode).toBe(0);
    expect(calls.confirmed).toBe(1);
    expect(calls.deleted).toEqual([FILE_ID]);
  });

  test("interactive prompt declined cancels without deleting", async () => {
    const { calls, deps } = harness(true, false);
    const exitCode = await runFileDelete({ id: FILE_ID, force: false, ...deps });
    expect(exitCode).toBe(0);
    expect(calls.deleted).toEqual([]);
    expect(calls.out).toContain("cancelled");
  });
});

describe("subkit files upload --link-to validation (#581)", () => {
  const makeRecordingClient = (requestedUrls: string[]) =>
    new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        requestedUrls.push(requestUrl);
        const body = requestUrl.includes("/links") ? makeLinkRow() : makeFileRow({ size_bytes: 5 });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

  test.each([
    ["00000000-0000-0000-0000-000000000001", /bad resource ref/],
    ["bogus:00000000-0000-0000-0000-000000000001", /bad resource_type 'bogus'/],
  ])("rejects malformed --link-to %s before any upload request", async (linkTo, expectedError) => {
    const requestedUrls: string[] = [];
    const client = makeRecordingClient(requestedUrls);
    const filePath = join(tmpDir, "small.txt");
    writeFileSync(filePath, "hello world");
    const { runFileUpload } = await import("../../commands/files.ts");
    await expect(
      runFileUpload(client, { path: filePath, linkTo, quiet: true, json: false }),
    ).rejects.toThrow(expectedError);
    expect(requestedUrls).toEqual([]);
  });

  test("uploads first, then links a valid --link-to target", async () => {
    const requestedUrls: string[] = [];
    const client = makeRecordingClient(requestedUrls);
    const filePath = join(tmpDir, "small.txt");
    writeFileSync(filePath, "hello world");
    const { runFileUpload } = await import("../../commands/files.ts");
    const uploadedRow = await runFileUpload(client, {
      path: filePath,
      linkTo: "conversation:00000000-0000-0000-0000-000000000002",
      role: "attachment",
      quiet: true,
      json: false,
    });
    expect(uploadedRow.id).toBe(makeFileRow().id);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain("/v1/files/inline");
    expect(requestedUrls[1]).toContain("/links");
  });
});
