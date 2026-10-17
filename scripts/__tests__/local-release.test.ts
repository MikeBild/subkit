import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalProvenance, assertReleaseSigningKey } from "../local-release-bundle.ts";
import { selectedReleaseCommit } from "../release-local.ts";

type Bundle = typeof import("../local-release-bundle.ts");
const roots: string[] = [];
const commit = "a".repeat(40);
const tag = "v1.2.3";
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 9)]),
  format: "der",
  type: "pkcs8",
});
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicPem = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
const provenance = {
  tag,
  commit,
  imageId: `sha256:${"b".repeat(64)}`,
  platform: "linux/amd64",
  gateContext: `subkit-release/${tag}`,
  smoke: "passed",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "subkit-local-bundle-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  const keyDirectory = join(root, "packages/cli-core/src");
  const assets = join(root, "assets");
  for (const path of [scripts, keyDirectory, assets]) mkdirSync(path, { recursive: true });
  for (const name of ["local-release-bundle.ts", "release-gate-provenance.ts"])
    writeFileSync(join(scripts, name), readFileSync(join(import.meta.dir, "..", name)));
  writeFileSync(
    join(keyDirectory, "release-public-key.ts"),
    `export const RELEASE_PUBLIC_KEY = ${JSON.stringify(publicPem)};\n`,
  );
  const bundle: Bundle = await import(join(scripts, "local-release-bundle.ts"));
  for (const name of bundle.LOCAL_RELEASE_FILES)
    writeFileSync(join(assets, name), `fixture ${name}\n`);
  writeFileSync(join(assets, "release-provenance.json"), JSON.stringify(provenance));
  return { assets, bundle };
}

describe("local release evidence", () => {
  test("resolves lightweight and annotated tags without confusing main", () => {
    expect(
      selectedReleaseCommit(`${commit}\trefs/heads/main\n${commit}\trefs/tags/${tag}`, tag),
    ).toBe(commit);
    expect(
      selectedReleaseCommit(
        `${"c".repeat(40)}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}`,
        tag,
      ),
    ).toBe(commit);
    expect(() => selectedReleaseCommit(`${commit}\trefs/heads/main`, tag)).toThrow();
  });

  test("rejects candidate, platform and smoke mismatches", () => {
    expect(assertLocalProvenance(provenance, tag, commit)).toEqual(provenance);
    for (const change of [
      { commit: "c".repeat(40) },
      { tag: "v9.9.9" },
      { platform: "linux/arm64" },
      { smoke: "failed" },
      { imageId: "subkit:latest" },
      { gateContext: "other" },
    ])
      expect(() => assertLocalProvenance({ ...provenance, ...change }, tag, commit)).toThrow();
  });

  test("production trust root refuses a fixture signing key", () => {
    expect(() => assertReleaseSigningKey(pem)).toThrow("trust root");
  });

  test("signs every deliverable and verifies the source-bound bundle", async () => {
    const { assets, bundle } = await fixture();
    bundle.signLocalBundle(assets, pem);
    expect(bundle.verifyLocalBundle(assets, tag, commit)).toEqual(provenance);
    expect(
      readFileSync(join(assets, "SHA256SUMS"), "utf8").split("\n").filter(Boolean),
    ).toHaveLength(bundle.LOCAL_RELEASE_FILES.length);
  });

  test("rejects a changed artifact after signing", async () => {
    const { assets, bundle } = await fixture();
    bundle.signLocalBundle(assets, pem);
    writeFileSync(join(assets, "subkit-clipper.zip"), "tampered");
    expect(() => bundle.verifyLocalBundle(assets, tag, commit)).toThrow("checksum");
  });

  test("rejects altered signature and altered manifest", async () => {
    const { assets, bundle } = await fixture();
    bundle.signLocalBundle(assets, pem);
    writeFileSync(join(assets, "SHA256SUMS.sig"), Buffer.alloc(64));
    expect(() => bundle.verifyLocalBundle(assets, tag, commit)).toThrow("signature");
    bundle.signLocalBundle(assets, pem);
    writeFileSync(join(assets, "SHA256SUMS"), "tampered");
    expect(() => bundle.verifyLocalBundle(assets, tag, commit)).toThrow("signature");
  });

  test("rejects missing and empty release artifacts before signing", async () => {
    const { assets, bundle } = await fixture();
    writeFileSync(join(assets, "sk_linux_x64"), "");
    expect(() => bundle.signLocalBundle(assets, pem)).toThrow("Empty release artifact");
    expect(existsSync(join(assets, "SHA256SUMS.sig"))).toBe(false);
    rmSync(join(assets, "sk_linux_x64"));
    expect(() => bundle.signLocalBundle(assets, pem)).toThrow();
  });

  test("a valid signature cannot authorize another candidate", async () => {
    const { assets, bundle } = await fixture();
    bundle.signLocalBundle(assets, pem);
    expect(() => bundle.verifyLocalBundle(assets, tag, "c".repeat(40))).toThrow("candidate");
  });
});

async function rejectedCommand(action: string[], mode: string) {
  const root = mkdtempSync(join(tmpdir(), "subkit-release-command-"));
  roots.push(root);
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  mkdirSync(join(root, "packages/cli-core/src"), { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const name of [
    "release-local.ts",
    "local-release-bundle.ts",
    "release-gate-provenance.ts",
    "gen-release-notes.ts",
    "lib/cockpit-demo-storage.ts",
  ]) {
    writeFileSync(join(root, "scripts", name), readFileSync(join(import.meta.dir, "..", name)));
  }
  writeFileSync(
    join(root, "packages/cli-core/src/release-public-key.ts"),
    `export const RELEASE_PUBLIC_KEY = ${JSON.stringify(publicPem)};\n`,
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: tag.slice(1) }));
  writeFileSync(join(root, ".bun-version"), Bun.version);
  const wrapper = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify({tool,args})+'\\n');
const commit = 'a'.repeat(40);
const tag = 'v1.2.3';
if (tool === 'git') {
  if (args[0] === 'branch') console.log('main');
  else if (args[0] === 'rev-parse') console.log(commit);
  else if (args[0] === 'ls-remote') console.log(commit+'\\trefs/heads/main\\n'+(process.env.RELEASE_TEST_MODE === 'moved-tag' ? 'b'.repeat(40) : commit)+'\\trefs/tags/'+tag);
  else if (args[0] !== 'status') process.exit(1);
} else if (tool === 'gh') {
  if (args[0] === 'repo') console.log(JSON.stringify({nameWithOwner:'MikeBild/subkit'}));
  else if (args.at(-1) === '.private') console.log('true');
  else console.log(JSON.stringify({sha:commit,statuses:process.env.RELEASE_TEST_MODE === 'missing-gate' ? [] : [{context:'subkit-release/'+tag,state:'success'}]}));
} else process.exit(99);
`;
  for (const name of ["git", "gh", "docker"])
    writeFileSync(join(root, "bin", name), wrapper, { mode: 0o755 });
  const log = join(root, "commands.jsonl");
  const proc = Bun.spawn([process.execPath, join(root, "scripts/release-local.ts"), ...action], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RELEASE_TEST_LOG: log,
      RELEASE_TEST_MODE: mode,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  const calls: Array<{ tool: string; args: string[] }> = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { status, stderr, calls };
}

describe("local publisher fail-closed command boundary", () => {
  test("publication without the explicit confirmation argument runs no tools", async () => {
    const result = await rejectedCommand(["publish", tag], "valid");
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  test("prepare and publish reject missing gate evidence before Docker or key access", async () => {
    for (const action of [
      ["prepare", tag, "--signing-key-file", "/missing-key"],
      ["publish", tag, "--confirm-publish", tag],
    ]) {
      const result = await rejectedCommand(action, "missing-gate");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no successful mandatory local gate");
      expect(result.calls.some((call) => call.tool === "docker")).toBe(false);
      expect(result.calls.some((call) => call.args.includes("create"))).toBe(false);
    }
  });

  test("a moved remote tag is rejected before GitHub or Docker", async () => {
    const result = await rejectedCommand(["check", tag], "moved-tag");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Remote main or tag differs");
    expect(result.calls.every((call) => call.tool === "git")).toBe(true);
  });

  test("a public launch cannot publish from a private repository", async () => {
    const result = await rejectedCommand(["publish", tag, "--confirm-publish", tag], "private");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already public repository");
    expect(result.calls.some((call) => call.tool === "docker")).toBe(false);
  });
});
