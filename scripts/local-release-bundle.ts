import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEY } from "../packages/cli-core/src/release-public-key.ts";
import { releaseGateContext } from "./release-gate-provenance.ts";

export const LOCAL_RELEASE_FILES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "docker-compose.yml",
  "engine_linux_x64",
  "release-notes.md",
  "release-provenance.json",
  "sk_darwin_arm64",
  "sk_darwin_x64",
  "sk_linux_arm64",
  "sk_linux_x64",
  "sk_windows_x64.exe",
  "subkit-clipper.zip",
] as const;

export interface LocalReleaseProvenance {
  tag: string;
  commit: string;
  imageId: string;
  platform: "linux/amd64";
  gateContext: string;
  smoke: "passed";
}

export function assertLocalProvenance(
  raw: unknown,
  tag: string,
  commit: string,
): LocalReleaseProvenance {
  if (!raw || typeof raw !== "object") throw new Error("Missing release provenance");
  const p = raw as Partial<LocalReleaseProvenance>;
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    p.commit !== commit ||
    p.tag !== tag ||
    p.gateContext !== releaseGateContext(tag) ||
    p.platform !== "linux/amd64" ||
    p.smoke !== "passed" ||
    typeof p.imageId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(p.imageId)
  ) {
    throw new Error("Release provenance does not match the selected candidate");
  }
  return p as LocalReleaseProvenance;
}

export function releaseChecksums(directory: string): string {
  return LOCAL_RELEASE_FILES.map((name) => {
    const bytes = readFileSync(join(directory, name));
    if (!bytes.length) throw new Error(`Empty release artifact: ${name}`);
    return `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
  }).join("");
}

export function signLocalBundle(directory: string, key: string): void {
  assertReleaseSigningKey(key);
  const sums = releaseChecksums(directory);
  const signature = sign(null, Buffer.from(sums), key);
  if (!verify(null, Buffer.from(sums), RELEASE_PUBLIC_KEY, signature)) {
    throw new Error("Signing key does not match the updater trust root");
  }
  writeFileSync(join(directory, "SHA256SUMS"), sums);
  writeFileSync(join(directory, "SHA256SUMS.sig"), signature);
}

export function assertReleaseSigningKey(key: string): void {
  const publicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString().trim();
  if (publicKey !== RELEASE_PUBLIC_KEY.trim())
    throw new Error("Signing key does not match the updater trust root");
}

export function verifyLocalBundle(
  directory: string,
  tag: string,
  commit: string,
): LocalReleaseProvenance {
  const sums = readFileSync(join(directory, "SHA256SUMS"));
  if (!verify(null, sums, RELEASE_PUBLIC_KEY, readFileSync(join(directory, "SHA256SUMS.sig")))) {
    throw new Error("Invalid release bundle signature");
  }
  if (sums.toString() !== releaseChecksums(directory))
    throw new Error("Release artifact checksum mismatch");
  return assertLocalProvenance(
    JSON.parse(readFileSync(join(directory, "release-provenance.json"), "utf8")),
    tag,
    commit,
  );
}
