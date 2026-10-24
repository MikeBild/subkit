import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
const offer = readFileSync(join(root, "deploy/docker/SOURCE_OFFER.txt"), "utf8").replace(
  /\s+/g,
  " ",
);
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function inventoryStep(): string {
  const start = runtime.indexOf(
    "RUN set -eu; \\\n    out=/usr/local/share/subkit/BASE_IMAGE_INVENTORY.txt",
  );
  expect(start).toBeGreaterThan(-1);
  const end = runtime.indexOf("\nCOPY", start);
  return runtime
    .slice(start + 4, end)
    .replace(/\\\n/g, "")
    .trim();
}

test("ships the source offer and base image inventory next to the notices", () => {
  expect(runtime).toContain(
    "COPY deploy/docker/SOURCE_OFFER.txt /usr/local/share/subkit/SOURCE_OFFER.txt",
  );
  expect(runtime.indexOf("THIRD_PARTY_NOTICES.txt /usr/local/share/subkit/")).toBeLessThan(
    runtime.indexOf("BASE_IMAGE_INVENTORY.txt"),
  );
  const step = inventoryStep();
  expect(step).toContain("dpkg-query -W");
  expect(step).toContain("source:Package");
  expect(step).toContain("/usr/share/doc/$name/copyright");
});

test("runs on a slim base without bundled browsers or Node.js", () => {
  const base = dockerfile.match(/^FROM (\S+) AS runtime$/m)?.[1] ?? "";
  expect(base).toMatch(/^docker\.io\/library\/ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
  expect(runtime.toLowerCase()).not.toContain("playwright");
  expect(runtime).not.toContain("node --version");
  expect(runtime).toMatch(/^USER subkit$/m);
  expect(runtime).toContain("useradd --uid 1001 --gid 1001");
});

test("inventory step lists packages and license files deterministically", () => {
  const directory = mkdtempSync(join(tmpdir(), "image-notices-"));
  temporary.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const query = join(bin, "dpkg-query");
  writeFileSync(
    query,
    "#!/bin/sh\nprintf 'zlib1g:amd64\\t1:1.3\\tzlib\\t1:1.3\\tzlib1g\\nbash\\t5.2\\tbash\\t5.2\\tbash\\n'\n",
  );
  chmodSync(query, 0o755);
  const out = join(directory, "inventory.txt");
  const script = inventoryStep().replaceAll(
    "/usr/local/share/subkit/BASE_IMAGE_INVENTORY.txt",
    out,
  );
  const run = spawnSync("sh", ["-c", script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  const lines = readFileSync(out, "utf8").split("\n");
  expect(lines.slice(1, 3)).toEqual([
    "bash\t5.2\tbash\t5.2\tmissing",
    "zlib1g:amd64\t1:1.3\tzlib\t1:1.3\tmissing",
  ]);
  expect(lines.slice(3).filter((line) => line.length > 0)).toEqual([]);
});

test("source offer names sources, duration and the private-repository state truthfully", () => {
  expect(offer).toContain("BASE_IMAGE_INVENTORY.txt");
  expect(offer).toContain("archive.ubuntu.com");
  expect(offer).toContain("launchpad.net");
  expect(offer).toContain("at least three years");
  expect(offer).toContain("RELINKING AND CORRESPONDING SOURCE");
  expect(offer).toContain("Once the SubKit repository is public");
});
