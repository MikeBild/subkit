import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
const opensslChecksEd25519 = (() => {
  const help = spawnSync("openssl", ["pkeyutl", "-help"], { encoding: "utf8" });
  return `${help.stdout}${help.stderr}`.includes("-rawin");
})();

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
  const asset = `subkit-${os.toLowerCase()}-${arch === "x86_64" ? "x64" : "arm64"}`;
  const bytes = Buffer.from("#!/bin/sh\nprintf 'verified fixture\\n'\n");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let manifest = `${hash}  ${asset}\n`;
  if (mode === "duplicate") manifest += manifest;
  if (mode === "missing") manifest = `${hash}  prefix-${asset}\n`;
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    const text = `Signed ${file} fixture\n`;
    const checksum = createHash("sha256").update(text).digest("hex");
    if (mode !== `missing-checksum-${file}`) manifest += `${checksum}  ${file}\n`;
    if (mode === `duplicate-checksum-${file}`) manifest += `${checksum}  ${file}\n`;
    if (mode !== `missing-${file}`)
      writeFileSync(join(downloads, file), mode === `tamper-${file}` ? "tampered" : text);
  }
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
  if (mode === "directory") mkdirSync(join(installed, "subkit"));
  else writeFileSync(join(installed, "subkit"), "previous binary");
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
    writeFileSync(join(installed, `subkit.${file}`), `previous ${file}`);
  if (mode === "fresh") rmSync(installed, { recursive: true });
  writeFileSync(
    join(bin, "uname"),
    `#!/bin/sh\nif [ "$1" = -s ]; then echo '${os}'; else echo '${arch}'; fi\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash
set -eu
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --proto|--proto-redir|--retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$FIXTURE_REQUESTS"
cp "$FIXTURE_DOWNLOADS/\${url##*/}" "$output"
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

describe("release installer", () => {
  test("installer and updater pin the same public key", () => {
    expect(
      installer.match(/-----BEGIN PUBLIC KEY-----\n[\s\S]*?\n-----END PUBLIC KEY-----/)?.[0],
    ).toBe(RELEASE_PUBLIC_KEY.trim());
  });

  test("creates a fresh installation only after verifying the release", () => {
    const f = fixture("fresh");
    expect(f.result.status, f.result.stderr).toBe(0);
    expect(readFileSync(join(f.installed, "subkit"))).toEqual(f.bytes);
    expect(f.result.stdout).toContain("checksums: verified");
    expect(f.result.stdout).toContain("Installed verified fixture");
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  test("downloads the stable latest-release links", () => {
    const f = fixture("valid");
    const requests = readFileSync(join(f.root, "requests"), "utf8").trim().split("\n");
    expect(requests[0]).toBe(
      "https://github.com/MikeBild/subkit/releases/latest/download/subkit-linux-x64",
    );
    expect(requests).toContain(
      "https://github.com/MikeBild/subkit/releases/latest/download/SHA256SUMS.sig",
    );
  });

  for (const [os, arch] of [
    ["Linux", "x86_64"],
    ["Linux", "aarch64"],
    ["Darwin", "arm64"],
  ]) {
    test(`installs the CLI and its notices for ${os}/${arch}`, () => {
      const f = fixture("valid", os, arch);
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(readFileSync(join(f.installed, "subkit"))).toEqual(f.bytes);
      expect(readdirSync(f.temporary)).toEqual([]);
      expect(readdirSync(f.installed).sort()).toEqual([
        "subkit",
        "subkit.LICENSE",
        "subkit.THIRD_PARTY_NOTICES.txt",
      ]);
      for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
        expect(readFileSync(join(f.installed, `subkit.${file}`), "utf8")).toBe(
          `Signed ${file} fixture\n`,
        );
      expect(readFileSync(join(f.root, "requests"), "utf8")).toContain(f.asset);
      expect(f.result.stdout).toContain(
        opensslChecksEd25519 ? "signature: verified" : "signature: skipped",
      );
    });
  }

  test("installs with checksums alone when no signature is published", () => {
    const f = fixture("signature-missing");
    expect(f.result.status, f.result.stderr).toBe(0);
    expect(f.result.stdout).toContain("signature: not published");
  });

  const signatureModes = opensslChecksEd25519 ? ["wrong-key", "signature-tamper"] : [];
  for (const mode of [
    ...["LICENSE", "THIRD_PARTY_NOTICES.txt"].flatMap((file) => [
      `missing-${file}`,
      `tamper-${file}`,
      `missing-checksum-${file}`,
      `duplicate-checksum-${file}`,
    ]),
    ...signatureModes,
    "manifest-tamper",
    "binary-tamper",
    "duplicate",
    "missing",
    "directory",
    "unsupported-platform",
  ]) {
    test(`preserves the existing installation on ${mode}`, () => {
      const f =
        mode === "unsupported-platform"
          ? fixture(mode, "Darwin", "x86_64")
          : fixture(mode, "Linux");
      expect(f.result.status).not.toBe(0);
      if (mode !== "directory")
        expect(readFileSync(join(f.installed, "subkit"), "utf8")).toBe("previous binary");
      for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
        expect(readFileSync(join(f.installed, `subkit.${file}`), "utf8")).toBe(`previous ${file}`);
      expect(readdirSync(f.temporary)).toEqual([]);
      expect(existsSync(join(f.installed, "release-public-key.pem"))).toBe(false);
    });
  }
});
