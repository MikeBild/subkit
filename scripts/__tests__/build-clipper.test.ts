import { describe, expect, test } from "bun:test";
import { fromBuffer } from "yauzl";
import { createClipperArchive } from "../build-clipper.ts";

async function readArchive(archive: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Archive could not be opened"));
      const files = new Map<string, string>();
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
            files.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

describe("clipper release archive", () => {
  test("preserves names and bytes in a standard ZIP independently of insertion order", async () => {
    const first = new Map([
      ["popup.html", Buffer.from("<title>SubKit Clipper</title>")],
      ["_locales/de/messages.json", Buffer.from('{"name":"Wissen"}')],
    ]);
    const archive = createClipperArchive(first);
    expect(archive).toEqual(createClipperArchive(new Map([...first].reverse())));
    expect(await readArchive(archive)).toEqual(
      new Map([...first].map(([name, bytes]) => [name, bytes.toString("utf8")])),
    );
  });

  test("rejects traversal in release archive paths", () => {
    expect(() => createClipperArchive(new Map([["../secret", Buffer.from("bad")]]))).toThrow(
      "Unsafe archive path",
    );
  });
});
