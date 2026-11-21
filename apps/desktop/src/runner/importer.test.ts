import { describe, expect, test } from "bun:test";
import { UPLOAD_CHUNK_MAX_BYTES } from "@shared/device/uploads.ts";
import { createImporter, type UploadPort } from "./importer.ts";

const UPLOAD = "0b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a11";
const FILE = "1b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a12";
const COMMAND = "a".repeat(64);
const SHA = "b".repeat(64);

function fakePort(overrides: Partial<UploadPort> = {}) {
  const calls: unknown[][] = [];
  const port: UploadPort = {
    create: async (body) => {
      calls.push(["create", body]);
      return { upload_id: UPLOAD, chunk_bytes_max: 4, expires_at: "2026-11-21T11:00:00.000Z" };
    },
    chunk: async (id, n, bytes) => {
      calls.push(["chunk", id, n, [...bytes]]);
    },
    commit: async (id, body) => {
      calls.push(["commit", id, body]);
      return { file_id: FILE };
    },
    abort: async (id) => {
      calls.push(["abort", id]);
    },
    ...overrides,
  };
  return { port, calls };
}

describe("importer over the runner upload routes", () => {
  test("cuts the stream into numbered chunks of the allowed size and commits hash and size", async () => {
    const { port, calls } = fakePort();
    const session = await createImporter(port).begin({
      command_id: COMMAND,
      name: "a.pdf",
      size: 10,
    });
    if (!session) throw new Error("expected a session");
    await session.write(new Uint8Array([1, 2, 3]));
    await session.write(new Uint8Array([4, 5, 6, 7, 8, 9]));
    await session.write(new Uint8Array([10]));
    expect(await session.commit(SHA)).toEqual({ file_id: FILE });
    expect(calls).toEqual([
      ["create", { command_id: COMMAND, name: "a.pdf", size: 10 }],
      ["chunk", UPLOAD, 0, [1, 2, 3, 4]],
      ["chunk", UPLOAD, 1, [5, 6, 7, 8]],
      ["chunk", UPLOAD, 2, [9, 10]],
      ["commit", UPLOAD, { sha256: SHA, size: 10 }],
    ]);
  });

  test("never sends a chunk above 4 MiB even if the server allows more", async () => {
    const sizes: number[] = [];
    const { port } = fakePort({
      create: async () => ({
        upload_id: UPLOAD,
        chunk_bytes_max: UPLOAD_CHUNK_MAX_BYTES * 2,
        expires_at: "2026-11-21T11:00:00.000Z",
      }),
      chunk: async (_id, _n, bytes) => {
        sizes.push(bytes.length);
      },
    });
    const session = await createImporter(port).begin({ command_id: COMMAND, name: "b", size: 0 });
    await session?.write(new Uint8Array(UPLOAD_CHUNK_MAX_BYTES + 1));
    await session?.commit(SHA);
    expect(sizes).toEqual([UPLOAD_CHUNK_MAX_BYTES, 1]);
  });

  test("commits an empty file without chunks and aborts on request", async () => {
    const { port, calls } = fakePort();
    const session = await createImporter(port).begin({ command_id: COMMAND, name: "e", size: 0 });
    expect(await session?.commit(SHA)).toEqual({ file_id: FILE });
    await session?.abort();
    expect(calls.map((call) => call[0])).toEqual(["create", "commit", "abort"]);
  });

  test("an unreadable answer yields no session or no file", async () => {
    const refused = fakePort({ create: async () => ({ code: "not_an_import" }) });
    expect(
      await createImporter(refused.port).begin({ command_id: COMMAND, name: "x", size: 1 }),
    ).toBeNull();
    const mismatch = fakePort({ commit: async () => ({ code: "hash_mismatch" }) });
    const session = await createImporter(mismatch.port).begin({
      command_id: COMMAND,
      name: "x",
      size: 0,
    });
    expect(await session?.commit(SHA)).toBeNull();
  });
});
