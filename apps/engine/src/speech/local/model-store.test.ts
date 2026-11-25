import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelFile } from "../core/model-files.ts";
import { createModelStore, speechModelDirFrom } from "./model-store.ts";

const body = new TextEncoder().encode("model-bytes");
const good: ModelFile = {
  path: "onnx/model.onnx",
  bytes: body.byteLength,
  sha256: createHash("sha256").update(body).digest("hex"),
};
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "speech-model-"));
  dirs.push(dir);
  return dir;
}

const serving = (bytes: Uint8Array<ArrayBuffer>, counter: { calls: number }) =>
  (async () => {
    counter.calls += 1;
    return new Response(bytes);
  }) as unknown as typeof fetch;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("model store", () => {
  test("downloads, verifies and then reports ready without downloading again", async () => {
    const dir = await tempDir();
    const counter = { calls: 0 };
    const store = createModelStore({ dir, files: [good], fetcher: serving(body, counter) });
    expect(await store.state()).toEqual({ kind: "missing" });
    expect(await store.prepare()).toEqual({ kind: "ready" });
    expect(new Uint8Array(await readFile(join(dir, good.path)))).toEqual(body);
    const again = createModelStore({ dir, files: [good], fetcher: serving(body, counter) });
    expect(await again.prepare()).toEqual({ kind: "ready" });
    expect(counter.calls).toBe(1);
  });

  test("refuses a file whose hash does not match and keeps nothing on disk", async () => {
    const dir = await tempDir();
    const tampered = new TextEncoder().encode("model-bytez");
    const store = createModelStore({
      dir,
      files: [good],
      fetcher: serving(tampered, { calls: 0 }),
    });
    const state = await store.prepare();
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.reason).toContain("integrity");
    expect(await createModelStore({ dir, files: [good] }).state()).toEqual({ kind: "missing" });
  });

  test("a file of the right size but foreign content is not taken as ready", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, good.path), new TextEncoder().encode("model-bytez"));
    expect(await createModelStore({ dir, files: [good] }).state()).toEqual({ kind: "missing" });
  });

  test("keeps the HTTP status of a failed download", async () => {
    const dir = await tempDir();
    const fetcher = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const state = await createModelStore({ dir, files: [good], fetcher }).prepare();
    expect(state.kind === "failed" && state.reason).toContain("HTTP 503");
  });

  test("puts the model next to the object store, else in a temporary folder, unless set", () => {
    const revision = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c";
    expect(
      speechModelDirFrom({
        explicit: "/models",
        objectStorageRoot: "/data/files",
        temporary: "/tmp",
      }),
    ).toBe("/models");
    expect(
      speechModelDirFrom({
        explicit: undefined,
        objectStorageRoot: "/data/files",
        temporary: "/tmp",
      }),
    ).toBe(join("/data", "speech-models", revision));
    expect(
      speechModelDirFrom({ explicit: undefined, objectStorageRoot: undefined, temporary: "/tmp" }),
    ).toBe(join("/tmp", "subkit-speech-models", revision));
  });
});
