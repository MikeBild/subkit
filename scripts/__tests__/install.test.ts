import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEY } from "../../packages/cli-core/src/release-public-key.ts";

const installer = readFileSync(join(import.meta.dir, "../install.sh"), "utf8");
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey)
  .export({ format: "pem", type: "spki" })
  .toString()
  .trim();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode = "valid", os = "Linux", arch = "x86_64") {
  const root = mkdtempSync(join(tmpdir(), "subkit-installer-"));
  roots.push(root);
  const bin = join(root, "bin");
  const downloads = join(root, "downloads");
  const installed = join(root, "installed");
  const temporary = join(root, "temporary");
  for (const dir of [bin, downloads, installed, temporary]) mkdirSync(dir);
  const asset = `sk_${os.toLowerCase()}_${arch === "x86_64" ? "x64" : "arm64"}`;
  const bytes = Buffer.from("#!/bin/sh\nprintf 'verified fixture\\n'\n");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let manifest = `${hash}  ${asset}\n`;
  if (mode === "duplicate") manifest += manifest;
  if (mode === "missing") manifest = `${hash}  prefix_${asset}\n`;
  writeFileSync(join(downloads, asset), mode === "binary-tamper" ? "tampered" : bytes);
  writeFileSync(
    join(downloads, "SHA256SUMS"),
    mode === "manifest-tamper" ? `${manifest}tampered\n` : manifest,
  );
  if (mode !== "signature-missing") {
    writeFileSync(
      join(downloads, "SHA256SUMS.sig"),
      mode === "signature-tamper"
        ? Buffer.alloc(64)
        : sign(null, Buffer.from(manifest), privateKey),
    );
  }
  writeFileSync(join(downloads, "latest.json"), JSON.stringify({ tag_name: "v1.2.3" }));
  writeFileSync(join(installed, "sk"), "previous binary");
  if (mode === "directory") mkdirSync(join(installed, "subkit"));
  else writeFileSync(join(installed, "subkit"), "previous alias");
  if (mode === "fresh") rmSync(installed, { recursive: true });
  writeFileSync(
    join(bin, "uname"),
    `#!/bin/sh\nif [ "$1" = -s ]; then echo '${os}'; else echo '${arch}'; fi\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "codesign"),
    `#!/bin/sh\nexit ${mode === "codesign-failure" ? "1" : "0"}\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash
set -eu
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output="$2"; shift 2; else url="$1"; shift; fi
done
printf '%s\\n' "$url" >> "$FIXTURE_REQUESTS"
if [[ "$url" = */releases/latest ]]; then cat "$FIXTURE_DOWNLOADS/latest.json"; else cp "$FIXTURE_DOWNLOADS/\${url##*/}" "$output"; fi
`,
    { mode: 0o755 },
  );
  const script = join(root, "install.sh");
  writeFileSync(
    script,
    mode === "wrong-key" ? installer : installer.replace(RELEASE_PUBLIC_KEY.trim(), publicKey),
  );
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: temporary,
      SUBKIT_INSTALL_DIR: installed,
      FIXTURE_DOWNLOADS: downloads,
      FIXTURE_REQUESTS: join(root, "requests"),
    },
  });
  return { result, root, installed, temporary, bytes, asset };
}

describe("signed GitHub installer", () => {
  test("installer and updater pin the same public key", () => {
    expect(
      installer.match(/-----BEGIN PUBLIC KEY-----\n[\s\S]*?\n-----END PUBLIC KEY-----/)?.[0],
    ).toBe(RELEASE_PUBLIC_KEY.trim());
  });

  test("creates a fresh installation only after verifying the release", () => {
    const f = fixture("fresh");
    expect(f.result.status, f.result.stderr).toBe(0);
    expect(readFileSync(join(f.installed, "sk"))).toEqual(f.bytes);
    expect(readlinkSync(join(f.installed, "subkit"))).toBe("sk");
    expect(f.result.stdout).not.toContain("verified fixture");
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  for (const [os, arch] of [
    ["Linux", "x86_64"],
    ["Linux", "aarch64"],
    ["Darwin", "arm64"],
    ["Darwin", "x86_64"],
  ]) {
    test(`installs the signed CLI and local alias for ${os}/${arch}`, () => {
      const f = fixture("valid", os, arch);
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(readFileSync(join(f.installed, "sk"))).toEqual(f.bytes);
      expect(readlinkSync(join(f.installed, "subkit"))).toBe("sk");
      expect(readdirSync(f.temporary)).toEqual([]);
      expect(readdirSync(f.installed).sort()).toEqual(["sk", "subkit"]);
      const requests = readFileSync(join(f.root, "requests"), "utf8");
      expect(requests).toContain(f.asset);
      expect(requests).not.toMatch(/\/subkit_(linux|darwin)/);
    });
  }

  for (const mode of [
    "wrong-key",
    "signature-missing",
    "signature-tamper",
    "manifest-tamper",
    "binary-tamper",
    "duplicate",
    "missing",
    "directory",
    "codesign-failure",
  ]) {
    test(`preserves the existing installation on ${mode}`, () => {
      const f = fixture(mode, mode === "codesign-failure" ? "Darwin" : "Linux");
      expect(f.result.status).not.toBe(0);
      expect(readFileSync(join(f.installed, "sk"), "utf8")).toBe("previous binary");
      if (mode !== "directory")
        expect(readFileSync(join(f.installed, "subkit"), "utf8")).toBe("previous alias");
      expect(readdirSync(f.temporary)).toEqual([]);
      expect(existsSync(join(f.installed, "release-public-key.pem"))).toBe(false);
    });
  }
});
