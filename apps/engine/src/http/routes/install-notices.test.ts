import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internal } from "./install.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(mode: string, source = "engine") {
  const root = mkdtempSync(join(tmpdir(), "engine-installer-notices-"));
  roots.push(root);
  const bin = join(root, "bin"),
    downloads = join(root, "downloads"),
    installed = join(root, "installed"),
    temporary = join(root, "temporary");
  for (const dir of [bin, downloads, installed, temporary]) mkdirSync(dir);
  const files = {
    sk_linux_x64: "candidate binary",
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
  writeFileSync(join(downloads, "SHA256SUMS"), sums.join("\n") + "\n");
  writeFileSync(join(installed, "sk"), "old binary");
  writeFileSync(join(installed, "subkit.LICENSE"), "old license");
  writeFileSync(join(installed, "subkit.THIRD_PARTY_NOTICES.txt"), "old notices");
  writeFileSync(
    join(bin, "uname"),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash
set -eu
output=''
head=false
while [ "$#" -gt 0 ]; do
 case "$1" in
  -o) output="$2"; shift 2 ;;
  --max-time) shift 2 ;;
  -fsSI) head=true; shift ;;
  *) url="$1"; shift ;;
 esac
done
if $head; then [ "$FIXTURE_SOURCE" = engine ]; exit; fi
name="\${url##*/}"
case "$name" in sk-linux-x64) name=sk_linux_x64 ;; sha256sums) name=SHA256SUMS ;; esac
cp "$FIXTURE_DOWNLOADS/$name" "$output"
`,
    { mode: 0o755 },
  );
  const script = join(root, "install.sh");
  writeFileSync(script, _internal.buildScript("1.0.0", "https://engine.example.com"));
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: temporary,
      SK_INSTALL_DIR: installed,
      SK_INSTALL_BASE_URL: "https://mirror.example.com",
      FIXTURE_SOURCE: source,
      FIXTURE_DOWNLOADS: downloads,
    },
  });
  return { result, installed, temporary };
}

for (const source of ["engine", "mirror"])
  test(`installs matching CLI and notices from ${source}`, () => {
    const f = run("valid", source);
    expect(f.result.status, f.result.stderr).toBe(0);
    expect(readFileSync(join(f.installed, "sk"), "utf8")).toBe("candidate binary");
    expect(readFileSync(join(f.installed, "subkit.LICENSE"), "utf8")).toBe("candidate license");
    expect(readFileSync(join(f.installed, "subkit.THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
      "candidate notices",
    );
    expect(readdirSync(f.temporary)).toEqual([]);
  });
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
  for (const problem of ["missing", "unlisted", "duplicate", "tampered"])
    test(`preserves existing installation for ${problem} ${file}`, () => {
      const f = run(`${problem}-${file}`);
      expect(f.result.status).not.toBe(0);
      expect(readFileSync(join(f.installed, "sk"), "utf8")).toBe("old binary");
      expect(readFileSync(join(f.installed, "subkit.LICENSE"), "utf8")).toBe("old license");
      expect(readFileSync(join(f.installed, "subkit.THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
        "old notices",
      );
      expect(readdirSync(f.temporary)).toEqual([]);
    });
