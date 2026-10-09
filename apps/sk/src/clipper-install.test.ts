import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _internal, installClipper } from "./clipper-install.ts";

const directories: string[] = [];

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (-(value & 1) & 0xedb88320);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function put16(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function put32(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function zip(files: Record<string, string>, symlinkName?: string): Uint8Array {
  const body: number[] = [];
  const central: number[] = [];
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const contents = new TextEncoder().encode(content);
    const crc = crc32(contents);
    const offset = body.length;
    put32(body, 0x04034b50);
    put16(body, 20);
    put16(body, 0);
    put16(body, 0);
    put16(body, 0);
    put16(body, 0);
    put32(body, crc);
    put32(body, contents.byteLength);
    put32(body, contents.byteLength);
    put16(body, nameBytes.byteLength);
    put16(body, 0);
    body.push(...nameBytes, ...contents);
    put32(central, 0x02014b50);
    put16(central, 20);
    put16(central, 20);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put32(central, crc);
    put32(central, contents.byteLength);
    put32(central, contents.byteLength);
    put16(central, nameBytes.byteLength);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put32(central, 0);
    put32(central, offset);
    central.push(...nameBytes);
  }
  const end: number[] = [];
  put32(end, 0x06054b50);
  put16(end, 0);
  put16(end, 0);
  put16(end, Object.keys(files).length);
  put16(end, Object.keys(files).length);
  put32(end, central.length);
  put32(end, body.length);
  put16(end, 0);
  const archive = new Uint8Array([...body, ...central, ...end]);
  if (symlinkName) {
    const centralStart = body.length;
    const nameOffset = [...Object.keys(files)].indexOf(symlinkName);
    if (nameOffset < 0) throw new Error("symlink entry is missing");
    let offset = centralStart;
    for (const name of Object.keys(files).slice(0, nameOffset)) {
      offset += 46 + new TextEncoder().encode(name).byteLength;
    }
    new DataView(archive.buffer).setUint32(offset + 38, 0o120777 << 16, true);
  }
  return archive;
}

async function makeFixture(
  files: Record<string, string>,
  symlinkName?: string,
): Promise<{ archivePath: string; targetDir: string }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-clipper-test-"));
  directories.push(dir);
  const archivePath = path.join(dir, "clipper.zip");
  await fs.writeFile(archivePath, zip(files, symlinkName));
  return { archivePath, targetDir: path.join(dir, "installed") };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("installClipper", () => {
  test("verifies, extracts, and writes only the first-run engine URL", async () => {
    const files = { "manifest.json": "{}", "popup.html": "<main></main>" };
    const fixture = await makeFixture(files);
    const bytes = await fs.readFile(fixture.archivePath);
    const result = await installClipper({
      archivePath: fixture.archivePath,
      manifest: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        files: Object.keys(files),
      },
      targetDir: fixture.targetDir,
      engineUrl: "http://localhost:3000",
    });

    expect(result).toBe(fixture.targetDir);
    expect(await fs.readFile(path.join(result, "popup.html"), "utf8")).toBe("<main></main>");
    expect(JSON.parse(await fs.readFile(path.join(result, "install-config.json"), "utf8"))).toEqual(
      {
        engine_url: "http://localhost:3000",
      },
    );
  });

  test("preserves an existing install suggestion on update", async () => {
    const firstFiles = { "manifest.json": "first" };
    const fixture = await makeFixture(firstFiles);
    const firstBytes = await fs.readFile(fixture.archivePath);
    await installClipper({
      archivePath: fixture.archivePath,
      manifest: {
        sha256: createHash("sha256").update(firstBytes).digest("hex"),
        files: Object.keys(firstFiles),
      },
      targetDir: fixture.targetDir,
      engineUrl: "http://localhost:3000",
    });
    const secondFiles = { "manifest.json": "second", "popup.html": "updated" };
    await fs.writeFile(fixture.archivePath, zip(secondFiles));
    const secondBytes = await fs.readFile(fixture.archivePath);
    await installClipper({
      archivePath: fixture.archivePath,
      manifest: {
        sha256: createHash("sha256").update(secondBytes).digest("hex"),
        files: Object.keys(secondFiles),
      },
      targetDir: fixture.targetDir,
      engineUrl: "https://example.test",
    });

    expect(
      JSON.parse(await fs.readFile(path.join(fixture.targetDir, "install-config.json"), "utf8")),
    ).toEqual({
      engine_url: "http://localhost:3000",
    });
    expect(await fs.readFile(path.join(fixture.targetDir, "manifest.json"), "utf8")).toBe("second");
  });

  test("rejects checksum failures before replacing an installed extension", async () => {
    const files = { "manifest.json": "{}" };
    const fixture = await makeFixture(files);
    await fs.mkdir(fixture.targetDir, { recursive: true });
    await fs.writeFile(path.join(fixture.targetDir, "previous.txt"), "keep");
    await expect(
      installClipper({
        archivePath: fixture.archivePath,
        manifest: { sha256: "0".repeat(64), files: Object.keys(files) },
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("checksum");
    expect(await fs.readFile(path.join(fixture.targetDir, "previous.txt"), "utf8")).toBe("keep");
  });

  test("rejects traversal entries and preserves the installed extension", async () => {
    const files = { "../outside.txt": "outside" };
    const fixture = await makeFixture(files);
    const bytes = await fs.readFile(fixture.archivePath);
    await fs.mkdir(fixture.targetDir, { recursive: true });
    await fs.writeFile(path.join(fixture.targetDir, "previous.txt"), "keep");

    await expect(
      installClipper({
        archivePath: fixture.archivePath,
        manifest: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          files: Object.keys(files),
        },
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow(/relative path|unsafe/);

    expect(await fs.readFile(path.join(fixture.targetDir, "previous.txt"), "utf8")).toBe("keep");
  });

  test("rejects symbolic-link entries during extraction", async () => {
    const files = { "linked.js": "target" };
    const fixture = await makeFixture(files, "linked.js");
    const bytes = await fs.readFile(fixture.archivePath);

    await expect(
      installClipper({
        archivePath: fixture.archivePath,
        manifest: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          files: Object.keys(files),
        },
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("unsafe");
  });
});

describe("safeArchivePath", () => {
  test("accepts extension files and rejects traversal", () => {
    expect(_internal.safeArchivePath("assets/popup.js")).toBe("assets/popup.js");
    expect(_internal.safeArchivePath("../outside")).toBeNull();
    expect(_internal.safeArchivePath("/outside")).toBeNull();
    expect(_internal.safeArchivePath("C:\\outside")).toBeNull();
  });
});
