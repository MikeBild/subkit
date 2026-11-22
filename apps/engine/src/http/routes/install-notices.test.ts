import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { _internal, pinInstallScript } from "./install.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FAKE_CURL = `#!/bin/bash
set -eu
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --proto|--proto-redir|--retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "$FIXTURE_LOG"
cp "$FIXTURE_DOWNLOADS/\${url##*/}" "$output"
`;

function run(mode: string, options: { uname?: [string, string]; version?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "engine-installer-"));
  roots.push(root);
  const bin = join(root, "bin"),
    downloads = join(root, "downloads"),
    installed = join(root, "installed"),
    temporary = join(root, "temporary");
  for (const dir of [bin, downloads, installed, temporary]) mkdirSync(dir);
  const files = {
    "subkit-linux-x64": "candidate binary",
    LICENSE: "candidate license",
    "THIRD_PARTY_NOTICES.txt": "candidate notices",
  };
  const sums: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    const line = `${createHash("sha256").update(text).digest("hex")}  ${name}`;
    if (mode !== `unlisted-${name}`) sums.push(line);
    if (mode === `duplicate-${name}`) sums.push(line);
    if (mode !== `missing-${name}`)
      writeFileSync(join(downloads, name), mode === `tampered-${name}` ? "tampered" : text);
  }
  writeFileSync(join(downloads, "SHA256SUMS"), `${sums.join("\n")}\n`);
  writeFileSync(join(installed, "subkit"), "old binary");
  writeFileSync(join(installed, "subkit.LICENSE"), "old license");
  writeFileSync(join(installed, "subkit.THIRD_PARTY_NOTICES.txt"), "old notices");
  const [system, machine] = options.uname ?? ["Linux", "x86_64"];
  writeFileSync(
    join(bin, "uname"),
    `#!/bin/sh\nif [ "$1" = -s ]; then echo ${system}; else echo ${machine}; fi\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  const log = join(root, "requests.log");
  writeFileSync(log, "");
  const script = join(root, "install.sh");
  writeFileSync(
    script,
    pinInstallScript(_internal.installScript, {
      version: options.version ?? "12.1.0",
      engineUrl: "https://engine.example.com",
      downloadUrl: mode === "release" ? null : "https://engine.example.com/install",
    }),
  );
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...testEnv,
      PATH: `${bin}:${testEnv.PATH}`,
      TMPDIR: temporary,
      SUBKIT_INSTALL_DIR: installed,
      FIXTURE_DOWNLOADS: downloads,
      FIXTURE_LOG: log,
    },
  });
  const requests = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { result, installed, temporary, requests };
}

test("installs the CLI and its notices from the engine bundle", () => {
  const f = run("valid");
  expect(f.result.status, f.result.stderr).toBe(0);
  expect(readFileSync(join(f.installed, "subkit"), "utf8")).toBe("candidate binary");
  expect(readFileSync(join(f.installed, "subkit.LICENSE"), "utf8")).toBe("candidate license");
  expect(readFileSync(join(f.installed, "subkit.THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
    "candidate notices",
  );
  expect(f.result.stdout).toContain("checksums: verified");
  expect(f.result.stdout).toContain("signature: not published");
  expect(f.result.stdout).toContain("subkit login --engine-url https://engine.example.com");
  expect(f.requests[0]).toBe("https://engine.example.com/install/subkit-linux-x64");
  expect(readdirSync(f.temporary)).toEqual([]);
});

test("a pinned engine without a bundle installs the release of its own version", () => {
  const f = run("release");
  expect(f.result.status, f.result.stderr).toBe(0);
  expect(f.requests[0]).toBe(
    "https://github.com/MikeBild/subkit/releases/download/v12.1.0/subkit-linux-x64",
  );
});

test("the release installer resolves the stable latest-download links", () => {
  const f = run("release", { version: "latest" });
  expect(f.result.status, f.result.stderr).toBe(0);
  expect(f.requests).toContain(
    "https://github.com/MikeBild/subkit/releases/latest/download/SHA256SUMS",
  );
});

test("refuses platforms without a build", () => {
  const f = run("valid", { uname: ["Darwin", "x86_64"] });
  expect(f.result.status).not.toBe(0);
  expect(f.result.stderr).toContain("no subkit build for darwin/x64");
  expect(readFileSync(join(f.installed, "subkit"), "utf8")).toBe("old binary");
});

for (const file of ["subkit-linux-x64", "LICENSE", "THIRD_PARTY_NOTICES.txt"])
  for (const problem of ["missing", "unlisted", "duplicate", "tampered"])
    test(`keeps the existing installation for a ${problem} ${file}`, () => {
      const f = run(`${problem}-${file}`);
      expect(f.result.status).not.toBe(0);
      expect(readFileSync(join(f.installed, "subkit"), "utf8")).toBe("old binary");
      expect(readFileSync(join(f.installed, "subkit.LICENSE"), "utf8")).toBe("old license");
      expect(readFileSync(join(f.installed, "subkit.THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
        "old notices",
      );
      expect(readdirSync(f.temporary)).toEqual([]);
    });
