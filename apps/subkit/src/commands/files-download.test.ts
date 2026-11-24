import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flush } from "../../../engine/src/test-helpers/determinism/wait.ts";
import { EngineClient } from "../engine-client.ts";
import { filesCommand } from "./files.ts";

const PROFILE_ENV = {
  SUBKIT_PROFILE: undefined,
  SUBKIT_ENGINE_URL: "https://engine.example.test",
  SUBKIT_API_KEY: "fixture",
  SUBKIT_TENANT: "tenant",
} as const;
const savedEnv = Object.fromEntries(
  Object.keys(PROFILE_ENV).map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;
for (const [key, value] of Object.entries(PROFILE_ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const encoder = new TextEncoder();
let nextStream: () => ReadableStream<Uint8Array> = () => new ReadableStream();
let advertisedBytes = 0;
const download = spyOn(EngineClient.prototype, "downloadFile").mockImplementation(async () => ({
  filename: "receipt.txt",
  content_type: "text/plain",
  size_bytes: advertisedBytes,
  stream: nextStream(),
}));

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const streamFailingAfter = (chunk: string) => {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    },
  });
};

let workDir = "";
let stderrOutput = "";
let uncaughtErrors: unknown[] = [];
const onUncaught = (err: unknown) => uncaughtErrors.push(err);

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "sk-files-download-"));
  stderrOutput = "";
  uncaughtErrors = [];
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
});
afterEach(async () => {
  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);
  download.mockClear();
  await rm(workDir, { recursive: true, force: true });
});
afterAll(() => {
  download.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function runDownload(output: string): Promise<void> {
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrOutput += String(chunk);
    return true;
  });
  try {
    const command = (filesCommand.subCommands as Record<string, unknown>).download as {
      run: (context: { args: Record<string, unknown> }) => Promise<void>;
    };
    await command.run({ args: { id: "fid_fixture", output, quiet: true } });
  } finally {
    await flush();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe("files download", () => {
  test("missing parent directory fails through the command error path naming the path", async () => {
    advertisedBytes = 5;
    nextStream = () => streamOf(["hello"]);
    const outPath = join(workDir, "nonexistent-parent", "receipt.txt");
    await expect(runDownload(outPath)).rejects.toThrow(outPath);
    expect(stderrOutput).toContain(outPath);
    expect(uncaughtErrors).toEqual([]);
    expect(existsSync(join(workDir, "nonexistent-parent"))).toBe(false);
  });

  test("interrupted stream keeps the previous complete file and leaves no temp file", async () => {
    const outPath = join(workDir, "approved.txt");
    await writeFile(outPath, "previous complete export");
    advertisedBytes = 2_162_688;
    nextStream = () => streamFailingAfter("partial-bytes");
    await expect(runDownload(outPath)).rejects.toThrow(/ECONNRESET/);
    expect(await readFile(outPath, "utf8")).toBe("previous complete export");
    expect(await readdir(workDir)).toEqual(["approved.txt"]);
    expect(uncaughtErrors).toEqual([]);
  });

  test("stream ending before the advertised size keeps the previous file", async () => {
    const outPath = join(workDir, "approved.txt");
    await writeFile(outPath, "previous complete export");
    advertisedBytes = 100;
    nextStream = () => streamOf(["short"]);
    await expect(runDownload(outPath)).rejects.toThrow(/5 of 100 bytes/);
    expect(await readFile(outPath, "utf8")).toBe("previous complete export");
    expect(await readdir(workDir)).toEqual(["approved.txt"]);
  });

  test("successful download writes the exact bytes and removes the temp file", async () => {
    const outPath = join(workDir, "approved.txt");
    await writeFile(outPath, "previous complete export");
    advertisedBytes = 11;
    nextStream = () => streamOf(["hello", " ", "world"]);
    await runDownload(outPath);
    expect(await readFile(outPath, "utf8")).toBe("hello world");
    expect(await readdir(workDir)).toEqual(["approved.txt"]);
  });
});
