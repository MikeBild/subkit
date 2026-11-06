import { afterAll, beforeAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTestNow } from "../../../../apps/engine/src/test-helpers/determinism/clock.ts";
import type { UpdaterConfig } from "../updater.ts";

export const TEST_NOW_MS = getTestNow();

export const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } =
  generateKeyPairSync("ed25519");

export const TEST_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY.export({
  format: "pem",
  type: "spki",
}).toString();

let tmpDir: string;

export function makeCacheDir(): string {
  const dir = mkdtempSync(join(tmpDir, "cache-"));
  return dir;
}

export function makeGitHubResponse(tag: string, assets: Array<{ name: string }> = []) {
  return {
    tag_name: tag,
    prerelease: false,
    body: "release notes",
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url: `https://github.com/test/repo/releases/download/${tag}/${a.name}`,
    })),
  };
}

export function makeFetchImpl(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

export function makeConfig(overrides: Partial<UpdaterConfig> = {}): UpdaterConfig {
  return {
    binaryName: "test-bin",
    currentVersion: "1.0.0",
    cacheDir: makeCacheDir(),
    githubRepo: "test/repo",
    checkIntervalMs: 86_400_000,
    channel: "stable",
    publicKey: TEST_PUBLIC_KEY_PEM,
    ...overrides,
  };
}

export function useUpdaterTmpDir(): void {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "updater-test-"));
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
}
