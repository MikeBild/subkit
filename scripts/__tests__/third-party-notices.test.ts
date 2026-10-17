import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNotices, renderNoticeDraft } from "../third-party-notices.ts";

const temporary: string[] = [];

async function fixture(notice?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "subkit-notices-"));
  temporary.push(root);
  const directory = join(root, "node_modules/example");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "example", version: "1", license: "MIT" }),
  );
  await writeFile(join(directory, "index.js"), "");
  if (notice !== undefined) await writeFile(join(directory, "LICENSE"), notice);
  return root;
}

afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

test("retains exact notice text and renders deterministically without machine paths", async () => {
  const root = await fixture("Copyright Example\r\nPermission text\r\n");
  const inputs = ["node_modules/example/index.js", "src/index.ts"];
  const first = await collectNotices(root, inputs);
  const second = await collectNotices(root, [...inputs].reverse().concat(inputs));
  expect(second).toEqual(first);
  expect(first[0]?.texts[0]?.text).toBe("Copyright Example\r\nPermission text\r\n");
  expect(renderNoticeDraft(first)).not.toContain(root);
  expect(renderNoticeDraft(first)).toContain("NOT A DISTRIBUTION APPROVAL");
});

test("keeps missing notices unverified rather than synthesizing a license", async () => {
  const root = await fixture();
  const packages = await collectNotices(root, ["node_modules/example/index.js"]);
  expect(packages[0]?.texts).toEqual([]);
  expect(renderNoticeDraft(packages)).toContain("UNVERIFIED");
});

test("rejects empty notices and malformed package metadata", async () => {
  const root = await fixture("   ");
  await expect(collectNotices(root, ["node_modules/example/index.js"])).rejects.toThrow("Empty");
  await writeFile(join(root, "node_modules/example/package.json"), "{");
  await expect(collectNotices(root, ["node_modules/example/index.js"])).rejects.toThrow();
});

test("rejects an input outside the selected repository", async () => {
  const root = await fixture("notice");
  await expect(collectNotices(root, ["../node_modules/example/index.js"])).rejects.toThrow(
    "escapes",
  );
});

test("rejects conflicting notices for duplicate package identities", async () => {
  const root = await fixture("notice");
  const copy = join(root, "node_modules/nested/node_modules/example");
  await mkdir(copy, { recursive: true });
  await writeFile(
    join(copy, "package.json"),
    JSON.stringify({ name: "example", version: "1", license: "MIT" }),
  );
  await writeFile(join(copy, "LICENSE"), "different notice");
  await expect(
    collectNotices(root, [
      "node_modules/example/index.js",
      "node_modules/nested/node_modules/example/index.js",
    ]),
  ).rejects.toThrow("Conflicting");
});
