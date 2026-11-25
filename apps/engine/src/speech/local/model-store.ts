import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readEnv } from "../../env.ts";
import { logger } from "../../logging/index.ts";
import {
  LOCAL_SPEECH_FILES,
  LOCAL_SPEECH_REVISION,
  type LocalModelState,
  type ModelFile,
  modelFileUrl,
} from "../core/model-files.ts";

export const speechModelDir = (): string =>
  readEnv("SPEECH_MODEL_DIR") ??
  join(homedir(), ".cache", "subkit", "speech", LOCAL_SPEECH_REVISION);

const fileOnDisk = async (dir: string, file: ModelFile): Promise<boolean> =>
  stat(join(dir, file.path)).then(
    (info) => info.size === file.bytes,
    () => false,
  );

async function downloadFile(
  dir: string,
  file: ModelFile,
  fetcher: typeof fetch,
  onBytes: (count: number) => void,
): Promise<void> {
  const target = join(dir, file.path);
  const partial = `${target}.partial`;
  await mkdir(dirname(target), { recursive: true });
  const response = await fetcher(modelFileUrl(file));
  if (!response.ok || !response.body)
    throw new Error(`download of ${file.path} failed with HTTP ${response.status}`);
  const hash = createHash("sha256");
  const writer = Bun.file(partial).writer();
  let received = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      writer.write(chunk);
      received += chunk.byteLength;
      onBytes(chunk.byteLength);
    }
  } finally {
    await writer.end();
  }
  const digest = hash.digest("hex");
  if (received !== file.bytes || digest !== file.sha256) {
    await rm(partial, { force: true });
    throw new Error(`${file.path} failed its integrity check`);
  }
  await rename(partial, target);
}

export function createModelStore({
  dir = speechModelDir(),
  fetcher = fetch,
  files = LOCAL_SPEECH_FILES,
}: {
  dir?: string;
  fetcher?: typeof fetch;
  files?: readonly ModelFile[];
} = {}) {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  let current: LocalModelState = { kind: "missing" };
  let inFlight: Promise<LocalModelState> | null = null;
  let checked = false;

  async function refresh(): Promise<LocalModelState> {
    const present = await Promise.all(files.map((file) => fileOnDisk(dir, file)));
    if (present.every(Boolean)) current = { kind: "ready" };
    checked = true;
    return current;
  }

  async function download(): Promise<LocalModelState> {
    const started = Date.now();
    let receivedBytes = 0;
    current = { kind: "downloading", receivedBytes, totalBytes };
    logger.info({
      module: "speech",
      action: "local_model.download.start",
      msg: "downloading the local speech model",
      total_bytes: totalBytes,
    });
    try {
      for (const file of files) {
        if (await fileOnDisk(dir, file)) {
          receivedBytes += file.bytes;
          continue;
        }
        await downloadFile(dir, file, fetcher, (count) => {
          receivedBytes += count;
          current = { kind: "downloading", receivedBytes, totalBytes };
        });
      }
      current = { kind: "ready" };
      logger.info({
        module: "speech",
        action: "local_model.download.done",
        msg: "local speech model is ready",
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      current = { kind: "failed", reason };
      logger.warn({
        module: "speech",
        action: "local_model.download.failed",
        msg: "local speech model download failed",
        error: reason,
      });
    }
    return current;
  }

  return {
    dir,
    async state(): Promise<LocalModelState> {
      return checked || current.kind === "downloading" ? current : refresh();
    },
    prepare(): Promise<LocalModelState> {
      if (current.kind === "ready") return Promise.resolve(current);
      inFlight ??= refresh()
        .then((state) => (state.kind === "ready" ? state : download()))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

export type ModelStore = ReturnType<typeof createModelStore>;
