import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadClipperAssets } from "./clipper-assets.ts";
import { installClipper } from "./clipper-install.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("embedded clipper archive", () => {
  test("installs every generated archive entry and writes no credential", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "subkit-clipper-asset-"));
    directories.push(directory);
    const targetDir = path.join(directory, "installed");

    const assets = await loadClipperAssets();
    await installClipper({
      ...assets,
      targetDir,
      engineUrl: "https://engine.example.test",
    });

    for (const file of assets.manifest.files) {
      expect(await fs.stat(path.join(targetDir, file))).toBeDefined();
    }
    expect(
      JSON.parse(await fs.readFile(path.join(targetDir, "install-config.json"), "utf8")),
    ).toEqual({
      engine_url: "https://engine.example.test",
    });
  });
});
