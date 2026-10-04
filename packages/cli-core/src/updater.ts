import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RELEASE_PUBLIC_KEY } from "./release-public-key.ts";

export const GITHUB_REPO = "mikebild/subkit";

export const RETAINED_VERSIONS_KEEP = 3;

export interface UpdaterConfig {
  binaryName: string;
  currentVersion: string;
  cacheDir: string;
  githubRepo: string;
  checkIntervalMs: number;
  channel: "stable" | "beta";
  publicKey?: string;
  authToken?: string;
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

export interface PerformUpdateResult {
  from_version: string;
  to_version: string;
  sha256: string;
}

export function platformArch(): { os: string; arch: string; ext: string } | null {
  const osMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap: Record<string, string> = { arm64: "arm64", x64: "x64" };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) return null;
  return { os, arch, ext: os === "windows" ? ".exe" : "" };
}

export function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

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

interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

export class UpdateCheckError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpdateCheckError";
  }
}

function releaseApiHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return headers;
}

function describeReleaseHttpError(status: number, repo: string, authToken?: string): string {
  if (status === 404) {
    return authToken
      ? `github releases API returned 404 for ${repo} — no published release found (or the token lacks access)`
      : `github releases API returned 404 for ${repo} — the repo is private (GitHub returns 404 to unauthenticated reads); set GITHUB_TOKEN / SUBKIT_UPDATE_TOKEN to enable self-update`;
  }
  if (status === 401 || status === 403) {
    return `github releases API returned ${status} for ${repo} — the update token is missing, invalid, or rate-limited`;
  }
  return `github releases API returned HTTP ${status} for ${repo}`;
}

async function fetchLatestRelease(
  repo: string,
  channel: "stable" | "beta",
  fetchImpl: typeof fetch = fetch,
  authToken?: string,
): Promise<GitHubRelease | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const headers = releaseApiHeaders(authToken);
    if (channel === "stable") {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        signal: controller.signal,
        headers,
      });
      if (!res.ok)
        throw new UpdateCheckError(
          describeReleaseHttpError(res.status, repo, authToken),
          res.status,
        );
      return (await res.json()) as GitHubRelease;
    }
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=1`, {
      signal: controller.signal,
      headers,
    });
    if (!res.ok)
      throw new UpdateCheckError(describeReleaseHttpError(res.status, repo, authToken), res.status);
    const releases = (await res.json()) as GitHubRelease[];
    return releases[0] ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

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
    release = await fetchLatestRelease(
      config.githubRepo,
      config.channel,
      fetchImpl,
      config.authToken,
    );
  } catch (err) {
    if (force) throw err;
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

export function verifySignature(
  message: string | Buffer,
  signature: Buffer,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey({ key: publicKeyPem, format: "pem", type: "spki" });
    const data = typeof message === "string" ? Buffer.from(message, "utf8") : message;
    return cryptoVerify(null, data, key, signature);
  } catch {
    return false;
  }
}

function versionsRoot(cacheDir: string): string {
  return join(cacheDir, "versions");
}

function versionDir(cacheDir: string, version: string): string {
  return join(versionsRoot(cacheDir), version);
}

function sidecarPath(versionDirPath: string): string {
  return join(versionDirPath, "manifest.json");
}

export interface RetainedVersion {
  version: string;
  path: string;
  installed_at: number;
  sha256: string;
}

interface RetainedManifest {
  version: string;
  installed_at: number;
  sha256: string;
  binary_name: string;
}

export function listRetainedVersions(config: UpdaterConfig): RetainedVersion[] {
  const root = versionsRoot(config.cacheDir);
  if (!existsSync(root)) return [];
  const out: RetainedVersion[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = readManifest(dir);
    if (!manifest) continue;
    const binPath = join(dir, manifest.binary_name);
    if (!existsSync(binPath)) continue;
    out.push({
      version: manifest.version,
      path: binPath,
      installed_at: manifest.installed_at,
      sha256: manifest.sha256,
    });
  }
  out.sort((a, b) => b.installed_at - a.installed_at);
  return out;
}

export function pruneRetainedVersions(config: UpdaterConfig, keep = RETAINED_VERSIONS_KEEP): void {
  const versions = listRetainedVersions(config);
  if (versions.length <= keep) return;
  for (const v of versions.slice(keep)) {
    const dir = join(versionsRoot(config.cacheDir), v.version);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function readManifest(dir: string): RetainedManifest | null {
  const p = sidecarPath(dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RetainedManifest;
  } catch {
    return null;
  }
}

function writeManifest(dir: string, manifest: RetainedManifest): void {
  writeFileSync(sidecarPath(dir), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function retainCurrentBinary(config: UpdaterConfig, fromVersion: string, execPath: string): void {
  const dir = versionDir(config.cacheDir, fromVersion);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, config.binaryName + (process.platform === "win32" ? ".exe" : ""));
  copyFileSync(execPath, dest);
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  writeManifest(dir, {
    version: fromVersion,
    installed_at: Date.now(),
    sha256: hashFile(dest),
    binary_name: config.binaryName + (process.platform === "win32" ? ".exe" : ""),
  });
}

export interface RollbackResult {
  from_version: string;
  to_version: string;
  sha256: string;
}

export function rollbackTo(config: UpdaterConfig, target: string | "previous"): RollbackResult {
  const versions = listRetainedVersions(config);
  if (versions.length === 0) {
    throw new Error("no retained binaries available — nothing to roll back to");
  }
  const picked = target === "previous" ? versions[0]! : versions.find((v) => v.version === target);
  if (!picked) {
    throw new Error(
      `no retained binary for version '${target}' (available: ${versions.map((v) => v.version).join(", ") || "none"})`,
    );
  }

  const onDisk = hashFile(picked.path);
  if (onDisk !== picked.sha256) {
    throw new Error(
      `retained binary for ${picked.version} failed integrity check (expected ${picked.sha256.slice(0, 12)}…, got ${onDisk.slice(0, 12)}…) — refusing to swap`,
    );
  }

  const fromVersion = config.currentVersion;
  const execPath = process.execPath;

  retainCurrentBinary(config, fromVersion, execPath);

  const isWindows = process.platform === "win32";
  if (isWindows) {
    const oldPath = `${execPath}.old`;
    try {
      unlinkSync(oldPath);
    } catch {}
    renameSync(execPath, oldPath);
    copyFileSync(picked.path, execPath);
  } else {
    const tmpPath = `${execPath}.rollback.${process.pid}`;
    copyFileSync(picked.path, tmpPath);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, execPath);
  }

  return {
    from_version: fromVersion,
    to_version: picked.version,
    sha256: picked.sha256,
  };
}

export async function performUpdate(
  config: UpdaterConfig,
  info: UpdateInfo,
  fetchImpl: typeof fetch = fetch,
): Promise<PerformUpdateResult> {
  const pa = platformArch();
  if (!pa) {
    throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  }

  const fromVersion = config.currentVersion;
  const toVersion = info.version;

  const assetName = `${config.binaryName}_${pa.os}_${pa.arch}${pa.ext}`;
  const asset = info.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `no binary '${assetName}' found in release ${info.tag}. Available: ${info.assets.map((a) => a.name).join(", ")}`,
    );
  }

  const sumsAsset = info.assets.find((a) => a.name === "SHA256SUMS");
  if (!sumsAsset) {
    throw new Error("no SHA256SUMS file found in release — cannot verify download");
  }
  const sigAsset = info.assets.find((a) => a.name === "SHA256SUMS.sig");
  if (!sigAsset) {
    throw new Error("no SHA256SUMS.sig file found in release — refusing to install");
  }

  const sumsRes = await fetchImpl(sumsAsset.url);
  if (!sumsRes.ok) throw new Error(`failed to download SHA256SUMS: ${sumsRes.status}`);
  const sumsText = await sumsRes.text();

  const sigRes = await fetchImpl(sigAsset.url);
  if (!sigRes.ok) throw new Error(`failed to download SHA256SUMS.sig: ${sigRes.status}`);
  const sigBuf = Buffer.from(await sigRes.arrayBuffer());

  const publicKeyPem = config.publicKey ?? RELEASE_PUBLIC_KEY;
  if (!verifySignature(sumsText, sigBuf, publicKeyPem)) {
    throw new Error("signature verification failed for SHA256SUMS — refusing to install");
  }

  const expectedHash = parseChecksum(sumsText, assetName);
  if (!expectedHash) {
    throw new Error(`no checksum found for '${assetName}' in SHA256SUMS`);
  }

  const tmpDir = join(config.cacheDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `${config.binaryName}.download.${process.pid}`);

  let actualHash = "";
  try {
    const binRes = await fetchImpl(asset.url);
    if (!binRes.ok) throw new Error(`failed to download ${assetName}: ${binRes.status}`);
    if (!binRes.body) throw new Error("empty response body");

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

    actualHash = hash.digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(
        `checksum mismatch for ${assetName}:\n  expected: ${expectedHash}\n  actual:   ${actualHash}`,
      );
    }

    const execPath = process.execPath;
    const isWindows = process.platform === "win32";

    if (!isWindows) {
      chmodSync(tmpPath, 0o755);
    }

    if (process.platform === "darwin") {
      const { execSync } = await import("node:child_process");
      try {
        execSync(`codesign --remove-signature "${tmpPath}" 2>/dev/null || true`, {
          stdio: "ignore",
        });
        execSync(`codesign --sign - --force "${tmpPath}"`, { stdio: "ignore" });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
          `macOS codesign failed for ${tmpPath} — install Xcode command-line tools (xcode-select --install) or check spctl: ${cause}`,
        );
      }
    }

    retainCurrentBinary(config, fromVersion, execPath);

    if (isWindows) {
      const oldPath = `${execPath}.old`;
      try {
        unlinkSync(oldPath);
      } catch {}
      renameSync(execPath, oldPath);
      renameSync(tmpPath, execPath);
    } else {
      renameSync(tmpPath, execPath);
    }

    writeCache(config.cacheDir, {
      last_check: Date.now(),
      latest_version: info.version,
      latest_tag: info.tag,
      current_version_at_check: info.version,
    });
    pruneRetainedVersions(config);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }

  return {
    from_version: fromVersion,
    to_version: toVersion,
    sha256: actualHash,
  };
}

export function parseChecksum(sumsText: string, assetName: string): string | null {
  for (const line of sumsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match && match[2] === assetName) {
      return match[1]!;
    }
  }
  return null;
}

export function formatUpdateBanner(info: UpdateInfo, binaryName: string): string {
  return (
    `\n  Update available: ${info.version}\n` +
    `  Run \`${binaryName} update\` to install the latest version.\n\n`
  );
}

export function defaultUpdaterConfig(
  binaryName: string,
  currentVersion: string,
  channel: "stable" | "beta" = "stable",
): UpdaterConfig {
  const isWindows = process.platform === "win32";
  const cacheDir = isWindows
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), binaryName)
    : join(homedir(), `.${binaryName}`);
  const authToken = process.env.GITHUB_TOKEN || process.env.SUBKIT_UPDATE_TOKEN;
  return {
    binaryName,
    currentVersion,
    cacheDir,
    githubRepo: GITHUB_REPO,
    checkIntervalMs: 86_400_000,
    channel,
    ...(authToken ? { authToken } : {}),
  };
}

export function cleanupOldBinary(): void {
  if (process.platform !== "win32") return;
  const oldPath = `${process.execPath}.old`;
  try {
    if (existsSync(oldPath)) unlinkSync(oldPath);
  } catch {}
}
