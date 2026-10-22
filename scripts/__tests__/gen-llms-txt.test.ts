import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  imageEntries,
  loadDocsImages,
  loadImageManifest,
  renderDocsImages,
  rewriteImages,
} from "../gen-llms-txt.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gen-llms-images-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vp8x(width: number, height: number): Uint8Array {
  const out = new Uint8Array(30);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 22, true);
  out.set(new TextEncoder().encode("WEBPVP8X"), 8);
  new DataView(out.buffer).setUint32(16, 10, true);
  out.set([(width - 1) & 0xff, (width - 1) >> 8, 0, (height - 1) & 0xff, (height - 1) >> 8, 0], 24);
  return out;
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("docs images in the bundle", () => {
  test("rewrites authored srcs and carries build, width and height into images[]", () => {
    const bytes = vp8x(1280, 720);
    writeFileSync(join(dir, "guide-run.de.webp"), bytes);
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ "guide-run.de.webp": { sha256: sha(bytes), build: "10.4.12" } }),
    );
    const images = loadDocsImages(dir);
    expect([...images.keys()]).toEqual(["guide-run.de.webp"]);
    const body = rewriteImages(
      "Text.\n\n![Ergebnis des Laufs](images/guide-run.de.webp)\n\n![Fehlt](images/missing.de.webp)\n",
      images,
    );
    const src = `/docs-images/guide-run.de.webp?v=${sha(bytes).slice(0, 12)}`;
    expect(body).toContain(`![Ergebnis des Laufs](${src})`);
    expect(body).toContain("![Fehlt](images/missing.de.webp)");
    expect(imageEntries(body, images)).toEqual([
      { src, alt: "Ergebnis des Laufs", build: "10.4.12", width: 1280, height: 720 },
      { src: "images/missing.de.webp", alt: "Fehlt" },
    ]);
  });

  test("drops a build whose manifest sha no longer matches the bytes", () => {
    writeFileSync(join(dir, "guide-run.en.webp"), vp8x(10, 10));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ "guide-run.en.webp": { sha256: "0".repeat(64), build: "10.4.12" } }),
    );
    expect(loadDocsImages(dir).get("guide-run.en.webp")?.build).toBeUndefined();
  });

  test("treats a missing folder or manifest as empty", () => {
    expect(loadImageManifest(dir)).toEqual({});
    expect(loadDocsImages(join(dir, "absent")).size).toBe(0);
  });

  test("renders the embedded module with one file import per image", () => {
    expect(renderDocsImages([])).toContain(
      "export const DOCS_IMAGES: Readonly<Record<string, EmbeddedDocsImage>> = {};",
    );
    const module = renderDocsImages([
      { file: "first-workflow-run-result.de.webp", sha256: "a".repeat(64), bytes: 42 },
    ]);
    expect(module).toStartWith(
      'import image0FirstWorkflowRunResultDe from "./reference/images/first-workflow-run-result.de.webp" with {\n  type: "file",\n};\n',
    );
    expect(module).toContain(
      `  "first-workflow-run-result.de.webp": {\n    path: image0FirstWorkflowRunResultDe,\n    sha256: "${"a".repeat(64)}",\n    bytes: 42,\n  },`,
    );
  });
});
