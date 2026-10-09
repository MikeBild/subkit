import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = join(import.meta.dir, "..");
const app = join(root, "apps/clipper");
const output = join(root, "assets/clipper");

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function createClipperArchive(files: ReadonlyMap<string, Uint8Array>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of [...files.keys()].sort()) {
    if (name.startsWith("/") || name.split("/").some((part) => part === "..")) {
      throw new Error(`Unsafe archive path: ${name}`);
    }
    const bytes = files.get(name);
    if (!bytes) throw new Error(`Missing archive entry: ${name}`);
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function staticFiles(directory: string, files: Map<string, Uint8Array>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await staticFiles(path, files);
    else if (entry.isFile()) {
      files.set(relative(join(app, "public"), path).replaceAll("\\", "/"), await readFile(path));
    }
  }
}

export async function buildClipper(check = false): Promise<string> {
  const files = new Map<string, Uint8Array>();
  await staticFiles(join(app, "public"), files);
  for (const [name, license] of [
    ["readability", "@mozilla/readability/LICENSE.md"],
    ["turndown", "turndown/LICENSE"],
  ] as const) {
    files.set(`licenses/${name}.txt`, await readFile(join(root, "node_modules", license)));
  }
  for (const name of ["service-worker", "capture", "popup", "options"]) {
    const result = await Bun.build({
      entrypoints: [join(app, "src", `${name}.ts`)],
      target: "browser",
      format: name === "capture" ? "iife" : "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!result.success) throw new AggregateError(result.logs, `Cannot build clipper ${name}`);
    if (result.outputs.length !== 1) throw new Error(`Unexpected clipper outputs for ${name}`);
    const artifact = result.outputs[0];
    if (!artifact) throw new Error(`Missing clipper output for ${name}`);
    files.set(`${name}.js`, new Uint8Array(await artifact.arrayBuffer()));
  }
  const archive = createClipperArchive(files);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const manifest = `${JSON.stringify({ sha256, files: [...files.keys()].sort() }, null, 2)}\n`;
  if (check) {
    const [existing, metadata] = await Promise.all([
      readFile(join(output, "clipper.zip")),
      readFile(join(output, "manifest.json"), "utf8"),
    ]);
    if (!archive.equals(existing) || metadata !== manifest) {
      throw new Error("Clipper archive is stale; run bun run build:clipper");
    }
  } else {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "clipper.zip"), archive);
    await writeFile(join(output, "manifest.json"), manifest);
  }
  return sha256;
}

if (import.meta.main) {
  const sha = await buildClipper(process.argv.includes("--check"));
  process.stdout.write(`SubKit Clipper ${sha}\n`);
}
