import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRuntimeNotices } from "./runtime-notices.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "runtime-notices-"));
  temporary.push(directory);
  const text = "Copyright Example\nPermission text\n";
  const entry = {
    component: "example",
    revision: "source-revision",
    path: "notice.txt",
    source: "https://example.test/source-revision/LICENSE",
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  const manifest = {
    runtime: { version: "runtime-version", revision: "runtime-revision" },
    scope: "Incomplete native inventory",
    files: [entry],
  };
  const path = join(directory, "manifest.json");
  await writeFile(join(directory, entry.path), text);
  await writeFile(path, JSON.stringify(manifest));
  return { directory, text, entry, manifest, path };
}

test("preserves attributed notice text and explicitly limits the claim", async () => {
  const { path, text, entry } = await fixture();
  const output = await renderRuntimeNotices(path, "runtime-version", "runtime-revision");
  expect(output).toContain(text);
  expect(output).toContain(entry.source);
  expect(output).toContain(entry.sha256);
  expect(output).toContain("Incomplete native inventory");
  expect(output).toContain("NOT A DISTRIBUTION APPROVAL");
  expect(await renderRuntimeNotices(path, "runtime-version", "runtime-revision")).toBe(output);
});

test("names Bun by default and another runtime on request", async () => {
  const { path } = await fixture();
  expect(await renderRuntimeNotices(path, "runtime-version", "runtime-revision")).toContain(
    "Bun runtime-version (runtime-revision)",
  );
  expect(
    await renderRuntimeNotices(path, "runtime-version", "runtime-revision", "Electron"),
  ).toContain("Electron runtime-version (runtime-revision)");
});

test("rejects a different runtime version or revision", async () => {
  const { path } = await fixture();
  await expect(renderRuntimeNotices(path, "other", "runtime-revision")).rejects.toThrow(
    "toolchain",
  );
  await expect(renderRuntimeNotices(path, "runtime-version", "other")).rejects.toThrow("toolchain");
});

test("rejects altered license bytes", async () => {
  const { directory, path } = await fixture();
  await writeFile(join(directory, "notice.txt"), "changed");
  await expect(renderRuntimeNotices(path, "runtime-version", "runtime-revision")).rejects.toThrow(
    "checksum",
  );
});

test("rejects traversal, duplicate entries and empty inventories", async () => {
  const { path, entry, manifest } = await fixture();
  for (const files of [[{ ...entry, path: "../outside" }], [entry, entry], []]) {
    await writeFile(path, JSON.stringify({ ...manifest, files }));
    await expect(
      renderRuntimeNotices(path, "runtime-version", "runtime-revision"),
    ).rejects.toThrow();
  }
});

test("renders the relinking statement and binds it to the runtime revision", async () => {
  const { path, manifest } = await fixture();
  const statement = "Relink with Bun runtime-revision; written offer for three years";
  await writeFile(path, JSON.stringify({ ...manifest, correspondingSource: statement }));
  const output = await renderRuntimeNotices(path, "runtime-version", "runtime-revision");
  expect(output).toContain("RELINKING AND CORRESPONDING SOURCE");
  expect(output).toContain(statement);
  await writeFile(path, JSON.stringify({ ...manifest, correspondingSource: "Relink with Bun" }));
  await expect(renderRuntimeNotices(path, "runtime-version", "runtime-revision")).rejects.toThrow(
    "runtime revision",
  );
});
