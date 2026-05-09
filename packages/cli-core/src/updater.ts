// Self-update module for `sk`, `subkit`, and `engine` binaries.
// Downloads new versions from GitHub Releases, verifies SHA256
// checksums, and replaces the running binary in-place.

import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const GITHUB_REPO = "mikebild/subkit";

export interface UpdaterConfig {
  binaryName: string;
  currentVersion: string;
  cacheDir: string;
  githubRepo: string;
  checkIntervalMs: number;
  channel: "stable" | "beta";
}

export interface UpdateInfo {
  version: string;
  tag: string;
  assets: Array<{ name: string; url: string }>;
  body: string;
}

export interface UpdateCache {
  last_check: number;
  latest_version: string;
  latest_tag: string;
  current_version_at_check: string;
}

// ── Platform detection ──

export function platformArch(): { os: string; arch: string; ext: string } | null {
  const osMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap: Record<string, string> = { arm64: "arm64", x64: "x64" };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) return null;
  return { os, arch, ext: os === "windows" ? ".exe" : "" };
}

// ── Semver comparison ──

export function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

// ── Cache management ──

function cachePath(cacheDir: string): string {
  return join(cacheDir, "update-check.json");
}

export function readCache(cacheDir: string): UpdateCache | null {
  const p = cachePath(cacheDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

export function writeCache(cacheDir: string, cache: UpdateCache): void {
  mkdirSync(cacheDir, { recursive: true });
  const p = cachePath(cacheDir);
  writeFileSync(p, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

// ── GitHub Releases API ──

interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

async function fetchLatestRelease(
  repo: string,
  channel: "stable" | "beta",
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRelease | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    if (channel === "stable") {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return null;
      return (await res.json()) as GitHubRelease;
    }
    // Beta: find the first release (including pre-releases)
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=1`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const releases = (await res.json()) as GitHubRelease[];
    return releases[0] ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Check for update ──

export async function checkForUpdate(
  config: UpdaterConfig,
  force = false,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  if (!force) {
    const cache = readCache(config.cacheDir);
    if (cache && Date.now() - cache.last_check < config.checkIntervalMs) {
      if (isNewer(cache.latest_version, config.currentVersion)) {
        return { version: cache.latest_version, tag: cache.latest_tag, assets: [], body: "" };
      }
      return null;
    }
  }

  let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
  try {
    release = await fetchLatestRelease(config.githubRepo, config.channel, fetchImpl);
  } catch {
    return null;
  }
  if (!release) return null;

  const version = release.tag_name.replace(/^v/, "");

  writeCache(config.cacheDir, {
    last_check: Date.now(),
    latest_version: version,
    latest_tag: release.tag_name,
    current_version_at_check: config.currentVersion,
  });

  if (!isNewer(version, config.currentVersion)) return null;

  return {
    version,
    tag: release.tag_name,
    assets: release.assets.map((a) => ({ name: a.name, url: a.browser_download_url })),
    body: release.body,
  };
}

// ── Perform update ──

export async function performUpdate(
  config: UpdaterConfig,
  info: UpdateInfo,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const pa = platformArch();
  if (!pa) {
    throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  }

  const assetName = `${config.binaryName}_${pa.os}_${pa.arch}${pa.ext}`;
  const asset = info.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `no binary '${assetName}' found in release ${info.tag}. Available: ${info.assets.map((a) => a.name).join(", ")}`,
    );
  }

  // Find SHA256SUMS asset
  const sumsAsset = info.assets.find((a) => a.name === "SHA256SUMS");
  if (!sumsAsset) {
    throw new Error("no SHA256SUMS file found in release — cannot verify download");
  }

  // Download SHA256SUMS
  const sumsRes = await fetchImpl(sumsAsset.url);
  if (!sumsRes.ok) throw new Error(`failed to download SHA256SUMS: ${sumsRes.status}`);
  const sumsText = await sumsRes.text();
  const expectedHash = parseChecksum(sumsText, assetName);
  if (!expectedHash) {
    throw new Error(`no checksum found for '${assetName}' in SHA256SUMS`);
  }

  // Download binary to temp file
  const tmpDir = join(config.cacheDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `${config.binaryName}.download.${process.pid}`);

  try {
    const binRes = await fetchImpl(asset.url);
    if (!binRes.ok) throw new Error(`failed to download ${assetName}: ${binRes.status}`);
    if (!binRes.body) throw new Error("empty response body");

    // Stream download + hash + progress
    const contentLength = Number(binRes.headers.get("content-length") || 0);
    const hash = createHash("sha256");
    const ws = createWriteStream(tmpPath);
    const readable = Readable.fromWeb(
      binRes.body as unknown as import("node:stream/web").ReadableStream,
    );
    let downloaded = 0;
    let lastProgress = -1;
    const isTTY = process.stderr.isTTY;
    readable.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      downloaded += chunk.length;
      if (isTTY && contentLength > 0) {
        const pct = Math.floor((downloaded / contentLength) * 100);
        if (pct !== lastProgress) {
          lastProgress = pct;
          const mb = (downloaded / 1_048_576).toFixed(1);
          const totalMb = (contentLength / 1_048_576).toFixed(1);
          process.stderr.write(`\r  downloading: ${mb}/${totalMb} MB (${pct}%)`);
        }
      }
    });
    await pipeline(readable, ws);
    if (isTTY && contentLength > 0) {
      process.stderr.write("\n");
    }

    const actualHash = hash.digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(
        `checksum mismatch for ${assetName}:\n  expected: ${expectedHash}\n  actual:   ${actualHash}`,
      );
    }

    // Platform-specific install
    const execPath = process.execPath;
    const isWindows = process.platform === "win32";

    if (!isWindows) {
      chmodSync(tmpPath, 0o755);
    }

    // macOS ad-hoc codesign
    if (process.platform === "darwin") {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`codesign --remove-signature "${tmpPath}" 2>/dev/null || true`, {
          stdio: "ignore",
        });
        execSync(`codesign --sign - --force "${tmpPath}"`, { stdio: "ignore" });
      } catch {
        // Non-fatal — binary will still work on most systems
      }
    }

    // Atomic replace
    if (isWindows) {
      // Windows: rename running exe to .old (Windows allows rename of running exe),
      // move new binary in, clean up .old on next run
      const oldPath = `${execPath}.old`;
      try {
        unlinkSync(oldPath);
      } catch {
        /* may not exist */
      }
      renameSync(execPath, oldPath);
      renameSync(tmpPath, execPath);
    } else {
      const bakPath = `${execPath}.bak`;
      renameSync(execPath, bakPath);
      renameSync(tmpPath, execPath);
      try {
        unlinkSync(bakPath);
      } catch {
        /* non-fatal */
      }
    }

    // Update cache
    writeCache(config.cacheDir, {
      last_check: Date.now(),
      latest_version: info.version,
      latest_tag: info.tag,
      current_version_at_check: info.version,
    });
  } catch (err) {
    // Clean up temp file on any error
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ── Helpers ──

export function parseChecksum(sumsText: string, assetName: string): string | null {
  for (const line of sumsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<hash>  <filename>" or "<hash> <filename>"
    const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match && match[2] === assetName) {
      return match[1]!;
    }
  }
  return null;
}

// ── Update banner ──

export function formatUpdateBanner(info: UpdateInfo, binaryName: string): string {
  return (
    `\n  Update available: ${info.version}\n` +
    `  Run \`${binaryName} update\` to install the latest version.\n\n`
  );
}

// ── Default config factories ──

export function defaultUpdaterConfig(
  binaryName: string,
  currentVersion: string,
  channel: "stable" | "beta" = "stable",
): UpdaterConfig {
  const isWindows = process.platform === "win32";
  const cacheDir = isWindows
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), binaryName)
    : join(homedir(), `.${binaryName}`);
  return {
    binaryName,
    currentVersion,
    cacheDir,
    githubRepo: GITHUB_REPO,
    checkIntervalMs: 86_400_000, // 24 hours
    channel,
  };
}

// ── Cleanup stale .old files on Windows ──

export function cleanupOldBinary(): void {
  if (process.platform !== "win32") return;
  const oldPath = `${process.execPath}.old`;
  try {
    if (existsSync(oldPath)) unlinkSync(oldPath);
  } catch {
    /* still locked — will be cleaned next time */
  }
}
