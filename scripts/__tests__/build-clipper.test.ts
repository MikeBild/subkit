import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { fromBuffer } from "yauzl";
import { chromeScriptSource, createClipperArchive } from "../build-clipper.ts";

async function readArchive(archive: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Archive could not be opened"));
      const files = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error("Entry could not be opened"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

describe("clipper release archive", () => {
  test("escapes Unicode noncharacters rejected by Chrome script injection", () => {
    expect(chromeScriptSource('const text = "\uffff\ufdd0\u{10ffff}";')).toBe(
      'const text = "\\uffff\\ufdd0\\udbff\\udfff";',
    );
    expect(chromeScriptSource('const text = "Grüße 🎵";')).toBe('const text = "Grüße 🎵";');
  });
  test("preserves names and bytes in a standard ZIP independently of insertion order", async () => {
    const first = new Map([
      ["popup.html", Buffer.from("<title>SubKit Clipper</title>")],
      ["_locales/de/messages.json", Buffer.from('{"name":"Wissen"}')],
    ]);
    const archive = createClipperArchive(first);
    expect(archive).toEqual(createClipperArchive(new Map([...first].reverse())));
    expect(await readArchive(archive)).toEqual(first);
  });

  test("shipped extension includes decodable-size icons and their source license", async () => {
    const root = join(import.meta.dir, "../..");
    const files = await readArchive(await readFile(join(root, "assets/clipper/clipper.zip")));
    const manifestBytes = files.get("manifest.json");
    if (!manifestBytes) throw new Error("Shipped extension manifest missing");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      icons: Record<string, string>;
      action: { default_icon: Record<string, string> };
    };
    expect(Object.keys(manifest.icons).sort()).toEqual(["128", "16", "32", "48"]);
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    for (const [size, name] of Object.entries(manifest.icons)) {
      const png = files.get(name);
      if (!png) throw new Error(`Missing icon: ${name}`);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.toString("ascii", 12, 16)).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(Number(size));
      expect(png.readUInt32BE(20)).toBe(Number(size));
      const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info.width).toBe(Number(size));
      expect(decoded.info.height).toBe(Number(size));
    }
    expect(files.get("licenses/lucide.txt")).toEqual(
      await readFile(join(root, "node_modules/lucide-react/LICENSE")),
    );
  });

  test("rejects traversal in release archive paths", () => {
    expect(() => createClipperArchive(new Map([["../secret", Buffer.from("bad")]]))).toThrow(
      "Unsafe archive path",
    );
  });
});
