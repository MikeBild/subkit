import { parseVersion } from "./version.ts";

export const CLI_BINARY = "subkit";

export const RELEASES_URL = "https://github.com/MikeBild/subkit/releases";

export const RELEASE_NOTICES = ["LICENSE", "THIRD_PARTY_NOTICES.txt"] as const;

export const CHECKSUMS_FILE = "SHA256SUMS";

export const SIGNATURE_FILE = "SHA256SUMS.sig";

export type ReleaseOs = "darwin" | "linux" | "windows";

export type ReleaseArch = "arm64" | "x64";

export interface ReleaseTarget {
  os: ReleaseOs;
  arch: ReleaseArch;
}

export const CLI_TARGETS: readonly ReleaseTarget[] = [
  { os: "darwin", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "windows", arch: "x64" },
];

const ENGINE_TARGETS: readonly ReleaseTarget[] = [{ os: "linux", arch: "x64" }];

const OS_BY_PLATFORM: Record<string, ReleaseOs> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCH_BY_NODE_ARCH: Record<string, ReleaseArch> = { arm64: "arm64", x64: "x64" };

export function releaseTarget(platform: string, arch: string): ReleaseTarget | null {
  const os = OS_BY_PLATFORM[platform];
  const releaseArch = ARCH_BY_NODE_ARCH[arch];
  return os && releaseArch ? { os, arch: releaseArch } : null;
}

export function cliAssetName(target: ReleaseTarget): string {
  return `${CLI_BINARY}-${target.os}-${target.arch}${target.os === "windows" ? ".exe" : ""}`;
}

export const CLI_ASSETS: readonly string[] = CLI_TARGETS.map(cliAssetName);

function supports(targets: readonly ReleaseTarget[], target: ReleaseTarget): boolean {
  return targets.some((t) => t.os === target.os && t.arch === target.arch);
}

export function releaseAssetFor(binaryName: string, platform: string, arch: string): string | null {
  const target = releaseTarget(platform, arch);
  if (!target) return null;
  if (binaryName === CLI_BINARY) return supports(CLI_TARGETS, target) ? cliAssetName(target) : null;
  if (binaryName === "engine") {
    return supports(ENGINE_TARGETS, target) ? `engine_${target.os}_${target.arch}` : null;
  }
  return null;
}

export function releaseDownloadBase(version: string, releasesUrl: string = RELEASES_URL): string {
  const base = releasesUrl.replace(/\/+$/, "");
  return version === "latest"
    ? `${base}/latest/download`
    : `${base}/download/v${version.replace(/^v/, "")}`;
}

export function releaseFileUrls(
  downloadBase: string,
  asset: string | null,
): Array<{ name: string; url: string }> {
  const base = downloadBase.replace(/\/+$/, "");
  const names = [CHECKSUMS_FILE, SIGNATURE_FILE, ...RELEASE_NOTICES];
  return (asset ? [asset, ...names] : names).map((name) => ({
    name,
    url: `${base}/${name}`,
  }));
}

export function versionFromReleaseLocation(location: string | null): string | null {
  if (!location) return null;
  const match = /\/releases\/tag\/v?([^/?#]+)\/?(?:[?#].*)?$/.exec(location);
  const version = match?.[1] ? decodeURIComponent(match[1]) : null;
  return version && parseVersion(version) ? version : null;
}
