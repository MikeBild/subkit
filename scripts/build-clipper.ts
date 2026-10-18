import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";
import sharp from "sharp";

const root = join(import.meta.dir, "..");
const app = join(root, "apps/clipper");
const output = join(root, "assets/clipper");

export function chromeScriptSource(source: string): string {
  return source.replace(/[\uFDD0-\uFFFF\u{10000}-\u{10FFFF}]/gu, (character) => {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 0xfdd0 || point > 0xfdef) && (point & 0xffff) < 0xfffe) return character;
    return character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
  });
}

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
  const icon = await readFile(join(root, "apps/cockpit/public/favicon.svg"));
  for (const size of [16, 32, 48, 128]) {
    files.set(
      `icons/icon-${size}.png`,
      await sharp(icon, { density: 384 })
        .resize(size === 128 ? 96 : size, size === 128 ? 96 : size)
        .extend({
          top: size === 128 ? 16 : 0,
          bottom: size === 128 ? 16 : 0,
          left: size === 128 ? 16 : 0,
          right: size === 128 ? 16 : 0,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9, adaptiveFiltering: false })
        .toBuffer(),
    );
  }
  files.set("licenses/lucide.txt", await readFile(join(root, "node_modules/lucide-react/LICENSE")));
  files.set("licenses/subkit.txt", await readFile(join(root, "LICENSE")));

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const version = packageJson.version;
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error("SubKit package version cannot be used as a Chrome extension version");
  }
  const sourceManifest = files.get("manifest.json");
  if (!sourceManifest) throw new Error("Clipper manifest is missing");
  const extensionManifest = JSON.parse(new TextDecoder().decode(sourceManifest)) as Record<
    string,
    unknown
  >;
  extensionManifest.version = version;
  files.set(
    "manifest.json",
    new TextEncoder().encode(`${JSON.stringify(extensionManifest, null, 2)}\n`),
  );
  for (const name of ["popup.html", "options.html"]) {
    const source = files.get(name);
    if (!source) throw new Error(`Clipper page is missing: ${name}`);
    const page = new TextDecoder().decode(source);
    if (!page.includes("@@SUBKIT_VERSION@@")) {
      throw new Error(`Clipper page has no version slot: ${name}`);
    }
    files.set(name, new TextEncoder().encode(page.replaceAll("@@SUBKIT_VERSION@@", version)));
  }
  for (const [name, license] of [
    ["defuddle", "defuddle/LICENSE"],
    ["turndown", "turndown/LICENSE"],
  ] as const) {
    files.set(`licenses/${name}.txt`, await readFile(join(root, "node_modules", license)));
  }
  const dependency = createRequire(import.meta.resolve("defuddle"));
  for (const [name, license] of [
    ["mathml-to-latex", "LICENSE.md"],
    ["temml", "LICENSE"],
  ] as const) {
    const directory = dirname(dependency.resolve(`${name}/package.json`));
    files.set(`licenses/${name}.txt`, await readFile(join(directory, license)));
  }
  const mathDependency = createRequire(dependency.resolve("mathml-to-latex/package.json"));
  const xmlDirectory = dirname(mathDependency.resolve("@xmldom/xmldom/package.json"));
  files.set("licenses/xmldom.txt", await readFile(join(xmlDirectory, "LICENSE")));
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
    files.set(`${name}.js`, new TextEncoder().encode(chromeScriptSource(await artifact.text())));
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
