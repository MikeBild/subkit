import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import pinJson from "../../vendor/agent-browser.json";
import {
  killBrowserSession,
  systemTeardown,
  type TeardownDeps,
} from "../runner/browser/teardown.ts";
import {
  AGENT_BROWSER_CONFIG_FILE,
  type BrowserLayout,
  type BrowserPin,
  BrowserPinSchema,
  type BrowserTarget,
  browserLayout,
  browserTargetFor,
  chromeDownload,
} from "../shared/local/browser-runtime.ts";

export const BROWSER_PIN: BrowserPin = BrowserPinSchema.parse(pinJson);

export interface BrowserRuntime {
  readonly cli_path: string;
  readonly version: string;
  readonly layout: BrowserLayout;
}

export type ChromeInstallState = "unsupported" | "missing" | "ready";

export interface BrowserHostOptions {
  readonly dataDir: string;
  readonly tmpDir: string;
  readonly cliPath: string;
  readonly platform: string;
  readonly arch: string;
  readonly fetch: typeof fetch;
  readonly unzip?: (zip: string, into: string) => void;
  readonly teardown?: TeardownDeps;
  readonly pin?: BrowserPin;
}

export interface BrowserHost {
  state(): ChromeInstallState;
  runtime(): BrowserRuntime | null;
  installChrome(signal: AbortSignal): Promise<BrowserRuntime>;
  killAll(): Promise<number[]>;
}

export class ChromeInstallError extends Error {}

function dittoUnzip(zip: string, into: string): void {
  const result = spawnSync("/usr/bin/ditto", ["-x", "-k", zip, into], { stdio: "ignore" });
  if (result.status !== 0)
    throw new ChromeInstallError("Chrome for Testing could not be unpacked.");
}

async function downloadVerified(
  fetcher: typeof fetch,
  url: string,
  bytes: number,
  sha256: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetcher(url, { signal });
  if (!response.ok || response.body === null)
    throw new ChromeInstallError(`Chrome for Testing download failed (${response.status}).`);
  const hash = createHash("sha256");
  let size = 0;
  const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    size += chunk.length;
    hash.update(chunk);
    if (size > bytes) source.destroy(new ChromeInstallError("Chrome for Testing is too large."));
  });
  await pipeline(source, createWriteStream(target, { mode: 0o600 }));
  if (size !== bytes || hash.digest("hex") !== sha256) {
    await rm(target, { force: true });
    throw new ChromeInstallError("Chrome for Testing does not match the pinned checksum.");
  }
}

export function createBrowserHost(options: BrowserHostOptions): BrowserHost {
  const pin = options.pin ?? BROWSER_PIN;
  const target: BrowserTarget | null = browserTargetFor(options.platform, options.arch);
  const layout =
    target === null ? null : browserLayout(options.dataDir, pin, target, options.tmpDir);
  const unzip = options.unzip ?? dittoUnzip;
  const teardown = options.teardown ?? systemTeardown;

  const ready = () =>
    layout !== null && existsSync(layout.chrome_executable) && existsSync(options.cliPath);

  const runtime = (): BrowserRuntime | null =>
    layout !== null && ready() ? { cli_path: options.cliPath, version: pin.version, layout } : null;

  const prepareFolders = async (current: BrowserLayout) => {
    for (const folder of [
      current.root,
      current.profiles,
      current.sockets,
      current.downloads,
      current.captures,
      join(current.root, "tmp"),
    ])
      await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(current.config, JSON.stringify(AGENT_BROWSER_CONFIG_FILE), { mode: 0o600 });
  };

  return {
    state() {
      if (layout === null) return "unsupported";
      return ready() ? "ready" : "missing";
    },
    runtime,
    async installChrome(signal) {
      if (layout === null || target === null)
        throw new ChromeInstallError("Websites are not available on this Mac.");
      await prepareFolders(layout);
      const existing = runtime();
      if (existing) return existing;
      const pinned = chromeDownload(pin, target);
      const zip = join(layout.root, "chrome-download.zip");
      const staging = `${layout.chrome_dir}.partial`;
      await rm(staging, { recursive: true, force: true });
      try {
        await downloadVerified(options.fetch, pinned.url, pinned.bytes, pinned.sha256, zip, signal);
        await mkdir(staging, { recursive: true, mode: 0o700 });
        unzip(zip, staging);
        await rm(layout.chrome_dir, { recursive: true, force: true });
        await rename(staging, layout.chrome_dir);
        await chmod(layout.chrome_dir, 0o700);
      } finally {
        await rm(zip, { force: true });
        await rm(staging, { recursive: true, force: true });
      }
      const installed = runtime();
      if (!installed) throw new ChromeInstallError("Chrome for Testing is incomplete.");
      return installed;
    },
    async killAll() {
      if (layout === null) return [];
      const partitions = await readdir(layout.profiles).catch(() => [] as string[]);
      const killed: number[] = [];
      for (const partition of partitions)
        killed.push(...(await killBrowserSession(layout, partition, teardown)));
      return killed;
    },
  };
}
