// `sk files` verb coverage — every verb exercised via mocked EngineClient.
//
// Tests call the command functions' underlying client methods directly
// rather than spawning the binary. The EngineClient is replaced with a
// mock `fetchImpl` so no real engine is needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  tmpDir = mkdtempSync(join(tmpdir(), "sk-files-cmd-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- list ----------

describe("sk files list", () => {
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

  test("wrong tenant gets 403 → SkEngineError", async () => {
    const { SkEngineError } = await import("../../engine-client.ts");
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
    await expect(client.listFiles()).rejects.toBeInstanceOf(SkEngineError);
  });
});

// ---------- get ----------

describe("sk files get", () => {
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

  test("404 for unknown id → SkEngineError status 404", async () => {
    const { SkEngineError } = await import("../../engine-client.ts");
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
    expect(err).toBeInstanceOf(SkEngineError);
    expect((err as InstanceType<typeof SkEngineError>).status).toBe(404);
  });
});

// ---------- upload (inline) ----------

describe("sk files upload — inline path (≤5 MB)", () => {
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

    // Write a tiny file to disk.
    const fp = join(tmpDir, "small.txt");
    writeFileSync(fp, "hello world");

    const { uploadPath } = await import("../../commands/files.ts");
    const result = await uploadPath(client, fp, { quiet: true });

    expect(capturedPath).toContain("/v1/files/inline");
    expect(result.id).toBe(row.id);
  });
});

// ---------- download ----------

describe("sk files download", () => {
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
          // getFile call
          return new Response(JSON.stringify(row), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // content streaming call
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

// ---------- delete ----------

describe("sk files delete", () => {
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
    const { SkEngineError } = await import("../../engine-client.ts");
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
    await expect(client.deleteFile("fid_x")).rejects.toBeInstanceOf(SkEngineError);
  });
});

// ---------- link ----------

describe("sk files link", () => {
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
    // The command-layer guard `parseResourceRef` rejects unknown
    // resource_type values locally so a typo fails before any HTTP
    // call. The guard is the public contract that keeps a typo like
    // `--to conversaton:<uuid>` from being sent to the engine just to
    // bounce back as 400 — verify it throws with a message that names
    // the offending type.
    const { parseResourceRef } = await import("../../commands/files.ts");
    expect(() => parseResourceRef("bogus_type:00000000-0000-0000-0000-000000000001")).toThrow(
      /bad resource_type 'bogus_type'/,
    );
    // Missing colon is also rejected with a distinct message so the
    // operator can tell shape errors from enum errors.
    expect(() => parseResourceRef("no-colon-here")).toThrow(/bad resource ref 'no-colon-here'/);
  });
});

// ---------- stats ----------

describe("sk files stats", () => {
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
    const { SkEngineError } = await import("../../engine-client.ts");
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
    await expect(client.getFileStats()).rejects.toBeInstanceOf(SkEngineError);
  });
});
