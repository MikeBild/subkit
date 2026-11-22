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
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  RELEASES_URL,
  releaseAssetFor,
  releaseDownloadBase,
  releaseFileUrls,
  versionFromReleaseLocation,
} from "./release/assets.ts";
import { UPDATE_CHECK_INTERVAL_MS } from "./release/update-policy.ts";
import { isNewer, stableVersion } from "./release/version.ts";
import {
  downloadReleaseNotices,
  readRetainedNotices,
  replaceWithNotices,
  retainReleaseNotices,
} from "./release-notices.ts";
import { RELEASE_PUBLIC_KEY } from "./release-public-key.ts";

export const RETAINED_VERSIONS_KEEP = 3;

export interface UpdaterConfig {
  binaryName: string;
  asset: string | null;
  currentVersion: string;
  cacheDir: string;
  releasesUrl: string;
  checkIntervalMs: number;
  publicKey?: string;
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

class UpdateCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateCheckError";
  }
}

const CHECK_TIMEOUT_MS = 5000;

function releaseInfo(config: UpdaterConfig, version: string, downloadBase: string): UpdateInfo {
  return {
    version,
    tag: `v${version}`,
    assets: releaseFileUrls(downloadBase, config.asset),
    body: "",
  };
}

export async function latestRelease(
  config: UpdaterConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo> {
  const latestUrl = `${config.releasesUrl.replace(/\/+$/, "")}/latest`;
  const res = await fetchImpl(latestUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  const version = stableVersion(versionFromReleaseLocation(res.headers.get("location")) ?? "");
  if (version)
    return releaseInfo(config, version, releaseDownloadBase(version, config.releasesUrl));
  if (res.status === 404 || (res.status >= 300 && res.status < 400)) {
    throw new UpdateCheckError(`no published release found at ${config.releasesUrl}`);
  }
  throw new UpdateCheckError(`the release server returned HTTP ${res.status} for ${latestUrl}`);
}

export interface EngineReleaseProbe {
  readonly installBase: string;
  version(): Promise<string>;
  hasInstallBundle(): Promise<boolean>;
}

export async function engineRelease(
  config: UpdaterConfig,
  engine: EngineReleaseProbe,
): Promise<UpdateInfo> {
  const version = stableVersion(await engine.version().catch(() => ""));
  if (!version) {
    throw new UpdateCheckError(
      `the engine at ${engine.installBase} did not report a release version`,
    );
  }
  const bundled = await engine.hasInstallBundle().catch(() => false);
  return releaseInfo(
    config,
    version,
    bundled ? engine.installBase : releaseDownloadBase(version, config.releasesUrl),
  );
}

export async function checkForUpdate(
  config: UpdaterConfig,
  force = false,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  if (!force) {
    const cache = readCache(config.cacheDir);
    if (cache && Date.now() - cache.last_check < config.checkIntervalMs) {
      return isNewer(cache.latest_version, config.currentVersion)
        ? releaseInfo(
            config,
            cache.latest_version,
            releaseDownloadBase(cache.latest_version, config.releasesUrl),
          )
        : null;
    }
  }

  let info: UpdateInfo;
  try {
    info = await latestRelease(config, fetchImpl);
  } catch (err) {
    if (force) throw err;
    return null;
  }

  const version = stableVersion(info.version);
  if (!version) return null;
  writeCache(config.cacheDir, {
    last_check: Date.now(),
    latest_version: version,
    latest_tag: `v${version}`,
    current_version_at_check: config.currentVersion,
  });

  return isNewer(version, config.currentVersion) ? info : null;
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
  notices?: Record<string, string>;
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
  const notices = retainReleaseNotices(execPath, dir);
  writeManifest(dir, {
    notices,
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

  const notices = readRetainedNotices(
    dirname(picked.path),
    readManifest(dirname(picked.path))?.notices,
  );
  retainCurrentBinary(config, fromVersion, execPath);

  replaceWithNotices(execPath, notices, () => {
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
  });

  return {
    from_version: fromVersion,
    to_version: picked.version,
    sha256: picked.sha256,
  };
}

export function prepareDownloadedBinary(path: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") chmodSync(path, 0o755);
}

export async function performUpdate(
  config: UpdaterConfig,
  info: UpdateInfo,
  fetchImpl: typeof fetch = fetch,
): Promise<PerformUpdateResult> {
  const assetName = config.asset;
  if (!assetName) {
    throw new Error(`no ${config.binaryName} build for ${process.platform}/${process.arch}`);
  }

  const fromVersion = config.currentVersion;
  const toVersion = info.version;

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

  const notices = await downloadReleaseNotices(
    info.assets,
    (name) => parseChecksum(sumsText, name),
    fetchImpl,
  );

  const execPath = process.execPath;
  const tmpPath = `${execPath}.download.${process.pid}`;

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

    const isWindows = process.platform === "win32";

    prepareDownloadedBinary(tmpPath, process.platform);

    retainCurrentBinary(config, fromVersion, execPath);

    replaceWithNotices(execPath, notices, () => {
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
    });

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
  let checksum: string | null = null;
  for (const line of sumsText.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!match || match[2] !== assetName) continue;
    if (checksum !== null || !/^[a-f0-9]{64}$/.test(match[1]!)) return null;
    checksum = match[1]!;
  }
  return checksum;
}

export function defaultUpdaterConfig(binaryName: string, currentVersion: string): UpdaterConfig {
  const isWindows = process.platform === "win32";
  const cacheDir = isWindows
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), binaryName)
    : join(homedir(), `.${binaryName}`);
  return {
    binaryName,
    asset: releaseAssetFor(binaryName, process.platform, process.arch),
    currentVersion,
    cacheDir,
    releasesUrl: process.env.SUBKIT_RELEASES_URL || RELEASES_URL,
    checkIntervalMs: UPDATE_CHECK_INTERVAL_MS,
  };
}

export function cleanupOldBinary(): void {
  if (process.platform !== "win32") return;
  const oldPath = `${process.execPath}.old`;
  try {
    if (existsSync(oldPath)) unlinkSync(oldPath);
  } catch {}
}
