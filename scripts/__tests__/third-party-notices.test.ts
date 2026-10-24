import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectNotices,
  noticeInputs,
  renderModelNotices,
  renderNoticeDraft,
  supplementNotices,
} from "../third-party-notices.ts";

const temporary: string[] = [];

test("supplements only the exact package version and verifies source bytes", async () => {
  const root = await fixture();
  const text = "Upstream copyright and permission";
  const manifest = join(root, "manifest.json");
  const entry = {
    name: "example",
    version: "1",
    qualification: "Source review remains separate",
    files: [
      {
        path: "upstream.txt",
        source: "https://example.test/pinned/LICENSE",
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
  await writeFile(join(root, "upstream.txt"), text);
  await writeFile(manifest, JSON.stringify([entry]));
  const packages = await collectNotices(root, ["node_modules/example/index.js"]);
  const supplemented = await supplementNotices(packages, manifest);
  expect(supplemented[0]?.texts[0]?.text).toBe(text);
  expect(renderNoticeDraft(supplemented)).toContain(entry.qualification);
  expect(packages[0]?.texts).toEqual([]);
  await writeFile(manifest, JSON.stringify([{ ...entry, version: "different" }]));
  expect((await supplementNotices(packages, manifest))[0]?.texts).toEqual([]);
  await writeFile(manifest, JSON.stringify([entry]));
  await writeFile(join(root, "upstream.txt"), "changed");
  await expect(supplementNotices(packages, manifest)).rejects.toThrow("checksum");
  await writeFile(
    manifest,
    JSON.stringify([{ ...entry, files: [{ ...entry.files[0], path: "../outside" }] }]),
  );
  await expect(supplementNotices(packages, manifest)).rejects.toThrow("path");
});

test("resolves browser source roots and shares package collection with Bun graphs", async () => {
  const root = await fixture("browser package notice");
  const graph = join(root, "browser.map");
  await writeFile(
    graph,
    JSON.stringify({ version: 3, sourceRoot: "node_modules", sources: ["example/index.js"] }),
  );
  const browser = await collectNotices(root, await noticeInputs(graph));
  await writeFile(graph, JSON.stringify({ inputs: { "node_modules/example/index.js": {} } }));
  expect(await collectNotices(root, await noticeInputs(graph))).toEqual(browser);
  expect(browser[0]?.texts[0]?.text).toBe("browser package notice");
});

test("rejects remote and malformed browser source maps", async () => {
  const root = await fixture("notice");
  const graph = join(root, "browser.map");
  for (const data of [
    { version: 3, sources: [42] },
    { version: 3, sourceRoot: "https://example.test/", sources: ["file.js"] },
    { version: 3, sources: ["file:///private/file.js"] },
  ]) {
    await writeFile(graph, JSON.stringify(data));
    await expect(noticeInputs(graph)).rejects.toThrow();
  }
});

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

test("records an applied license and statement without supplemental files", async () => {
  const root = await fixture("Dual license text");
  const manifest = join(root, "manifest.json");
  const entry = {
    name: "example",
    version: "1",
    qualification: "Dual-licensed; elects MIT",
    license: "MIT",
    statement: "Distributed unmodified; source at the pinned package archive",
  };
  await writeFile(manifest, JSON.stringify([entry]));
  const packages = await collectNotices(root, ["node_modules/example/index.js"]);
  const supplemented = await supplementNotices(packages, manifest);
  expect(supplemented[0]?.applied).toBe("MIT");
  const draft = renderNoticeDraft(supplemented);
  expect(draft).toContain("Applied license: MIT");
  expect(draft).toContain(`Statement: ${entry.statement}`);
  expect(packages[0]?.applied).toBeUndefined();
  await writeFile(manifest, JSON.stringify([{ ...entry, license: "MIT; rm" }]));
  await expect(supplementNotices(packages, manifest)).rejects.toThrow("license");
  await writeFile(
    manifest,
    JSON.stringify([{ name: "example", version: "1", qualification: "nothing applied" }]),
  );
  await expect(supplementNotices(packages, manifest)).rejects.toThrow("evidence");
});

test("binds model notices to the pinned embedding assets and verifies the license text", async () => {
  const root = await fixture();
  const text = "Apache License text";
  const assets = join(root, "assets.json");
  const manifest = join(root, "models.json");
  await writeFile(
    assets,
    JSON.stringify({
      model: "org/model",
      revision: "abc",
      files: [{ local: "model.onnx", sha256: "f".repeat(64) }],
    }),
  );
  await writeFile(join(root, "model-license.txt"), text);
  const entry = {
    model: "org/model",
    revision: "abc",
    upstream: "upstream/model",
    license: "Apache-2.0",
    attribution: "Model authors",
    qualification: "Per upstream model card",
    files: [
      {
        path: "model-license.txt",
        source: "https://example.test/LICENSE",
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
  await writeFile(manifest, JSON.stringify([entry]));
  const rendered = await renderModelNotices(manifest, assets);
  expect(rendered).toContain("org/model@abc");
  expect(rendered).toContain(`Asset: model.onnx SHA-256: ${"f".repeat(64)}`);
  expect(rendered).toContain(text);
  await writeFile(manifest, JSON.stringify([{ ...entry, revision: "other" }]));
  await expect(renderModelNotices(manifest, assets)).rejects.toThrow("pinned");
  await writeFile(manifest, JSON.stringify([entry]));
  await writeFile(join(root, "model-license.txt"), "changed");
  await expect(renderModelNotices(manifest, assets)).rejects.toThrow("checksum");
});
