import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const cockpitDemoFingerprintInputs = [
  "vendor/embedding-assets.json",
  "docker/docker-compose.test.yml",
  "docker/docker-compose.demo.yml",
  "scripts/start-cockpit-demo.ts",
  "scripts/verify-cockpit-local-demo.ts",
  "scripts/verify-cockpit-local.ts",
  "scripts/lib/cockpit-demo-instance.ts",
  "scripts/lib/cockpit-demo-fingerprint.ts",
  "scripts/lib/cockpit-demo-seed.ts",
  "scripts/lib/cockpit-demo-server.ts",
  "scripts/lib/cockpit-demo-storage.ts",
  "scripts/lib/cockpit-demo-verification.ts",
];
const cockpitDemoFingerprintInputSet = new Set(cockpitDemoFingerprintInputs);
const sourceRoots = [
  "apps",
  "packages",
  "assets",
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "scripts/gen-embedded-cockpit.ts",
  "scripts/build-clipper.ts",
  "scripts/fetch-embedding-assets.ts",
  "scripts/stage-cli-binaries.ts",
  "docker",
];

export function cockpitDemoSourceFingerprint(root: string, discoveredPaths: string[]): string {
  const paths = [...new Set([...discoveredPaths, ...cockpitDemoFingerprintInputs])].sort();
  const hash = createHash("sha256");
  for (const name of paths) {
    if (
      !cockpitDemoFingerprintInputSet.has(name) &&
      /(?:\.test\.|\/tests\/|\/__tests__\/|\/node_modules\/)/.test(name)
    )
      continue;
    const path = join(root, name);
    if (existsSync(path)) hash.update(name).update(readFileSync(path));
  }
  return hash.digest("hex");
}

export function cockpitDemoCheckoutFingerprint(root: string): string {
  const paths = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...sourceRoots],
    { cwd: root, encoding: "utf8" },
  );
  if (paths.status !== 0) throw new Error("Cannot identify the local source files");
  return cockpitDemoSourceFingerprint(root, paths.stdout.split("\0").filter(Boolean));
}
