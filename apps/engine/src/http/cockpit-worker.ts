import { createHash } from "node:crypto";

export const COCKPIT_WORKER_CORE = "worker-notify.js";
export const COCKPIT_BROWSER_WORKER = "browser-worker.js";
export const COCKPIT_INSTALLATION_WORKER = "installation-worker.js";

const COCKPIT_PREFIX = "/cockpit";
const HASHED_ASSET = /^assets\/[A-Za-z0-9._-]+$/;
const decoder = new TextDecoder();

export function cockpitBuildId(parts: readonly (Uint8Array | string)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

export function cockpitShellUrls(assetPaths: readonly string[]): string[] {
  return [...new Set(assetPaths)]
    .filter((path) => HASHED_ASSET.test(path))
    .sort()
    .map((path) => `${COCKPIT_PREFIX}/${path}`);
}

export function joinWorkerSources(sources: readonly Uint8Array[]): string {
  return sources.map((source) => decoder.decode(source).trimEnd()).join("\n");
}

export function cockpitInstallationWorkerScript(input: {
  shell: Uint8Array;
  assetPaths: readonly string[];
  sources: readonly Uint8Array[];
}): string {
  const urls = cockpitShellUrls(input.assetPaths);
  const body = joinWorkerSources(input.sources);
  const build = cockpitBuildId([input.shell, urls.join("\n"), body]);
  return `self.COCKPIT_BUILD = ${JSON.stringify(build)};\nself.COCKPIT_SHELL = ${JSON.stringify(urls)};\n${body}\n`;
}
