import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  BRANDING_IMAGE_MAX_BYTES,
  BrandingImageError,
  normalizeBrandingAppIcon,
  normalizeBrandingImage,
} from "./branding-image.ts";

async function image(format: "png" | "jpeg" | "webp", width = 32, height = 16) {
  return sharp({ create: { width, height, channels: 4, background: "#2563eb" } })
    .toFormat(format)
    .toBuffer();
}

function input(bytes: Buffer, mime_type = "image/png") {
  return { mime_type, content_base64: bytes.toString("base64") };
}

function webpWithCanvas(bytes: Buffer, width: number, height: number) {
  const canvas = Buffer.alloc(18);
  canvas.write("VP8X", 0, "ascii");
  canvas.writeUInt32LE(10, 4);
  canvas[12] = (width - 1) & 0xff;
  canvas[13] = ((width - 1) >>> 8) & 0xff;
  canvas[14] = ((width - 1) >>> 16) & 0xff;
  canvas[15] = (height - 1) & 0xff;
  canvas[16] = ((height - 1) >>> 8) & 0xff;
  canvas[17] = ((height - 1) >>> 16) & 0xff;
  const output = Buffer.concat([bytes.subarray(0, 12), canvas, bytes.subarray(12)]);
  output.writeUInt32LE(output.length - 8, 4);
  return output;
}

describe("tenant branding image admission", () => {
  for (const [format, mime] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ] as const) {
    test(`normalizes ${format} into a still PNG without enlarging it`, async () => {
      const normalized = await normalizeBrandingImage(input(await image(format), mime));
      const meta = await sharp(normalized).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(32);
      expect(meta.height).toBe(16);
      expect(meta.pages ?? 1).toBe(1);
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
    });
  }

  test("applies orientation, bounds both edges and strips EXIF metadata", async () => {
    const bytes = await sharp(await image("jpeg", 1024, 512))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const normalized = await normalizeBrandingImage(input(bytes, "image/jpeg"));
    const meta = await sharp(normalized).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(512);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  test("normalizes progressive JPEG", async () => {
    const bytes = await sharp({
      create: { width: 32, height: 16, channels: 4, background: "#2563eb" },
    })
      .jpeg({ progressive: true })
      .toBuffer();
    const normalized = await normalizeBrandingImage(input(bytes, "image/jpeg"));
    expect((await sharp(normalized).metadata()).format).toBe("png");
  });

  test("applies every EXIF orientation to asymmetric JPEG pixels", async () => {
    const source = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0,
      255, 255,
    ]);
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const bytes = await sharp(source, { raw: { width: 3, height: 2, channels: 4 } })
        .withMetadata({ orientation })
        .jpeg({ quality: 100 })
        .toBuffer();
      const expected = await sharp(bytes)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const normalized = await sharp(await normalizeBrandingImage(input(bytes, "image/jpeg")))
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(normalized.info.width).toBe(expected.info.width);
      expect(normalized.info.height).toBe(expected.info.height);
      for (let index = 0; index < normalized.data.length; index += 1) {
        const actualValue = normalized.data[index] ?? -1;
        const expectedValue = expected.data[index] ?? -1;
        expect(Math.abs(actualValue - expectedValue)).toBeLessThanOrEqual(20);
      }
    }
  });

  test("rejects a PNG mislabeled as JPEG", async () => {
    await expect(
      normalizeBrandingImage(input(await image("png"), "image/jpeg")),
    ).rejects.toBeInstanceOf(BrandingImageError);
  });

  test("rejects SVG, GIF, invalid image data and truncated decoders", async () => {
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      Buffer.from("GIF89a"),
      Buffer.from("not an image"),
      (await image("png")).subarray(0, 32),
    ]) {
      await expect(normalizeBrandingImage(input(bytes))).rejects.toBeInstanceOf(BrandingImageError);
    }
  });

  test("rejects noncanonical base64 and data URLs", async () => {
    const encoded = (await image("png")).toString("base64");
    for (const content_base64 of ["", `${encoded}\n`, `data:image/png;base64,${encoded}`, "a==="]) {
      await expect(
        normalizeBrandingImage({ mime_type: "image/png", content_base64 }),
      ).rejects.toBeInstanceOf(BrandingImageError);
    }
  });

  test("rejects uploads larger than the byte ceiling before decoding", async () => {
    const bytes = Buffer.alloc(BRANDING_IMAGE_MAX_BYTES + 1);
    await expect(normalizeBrandingImage(input(bytes))).rejects.toBeInstanceOf(BrandingImageError);
  });

  test("rejects images above the decoded pixel ceiling", async () => {
    await expect(
      normalizeBrandingImage(input(await image("png", 2500, 2000))),
    ).rejects.toBeInstanceOf(BrandingImageError);
  });

  test("rejects APNG control chunks even when the decoder could select a still frame", async () => {
    const bytes = await image("png");
    const control = Buffer.alloc(20);
    control.writeUInt32BE(8);
    control.write("acTL", 4, "ascii");
    control.writeUInt32BE(2, 8);
    const animated = Buffer.concat([bytes.subarray(0, 33), control, bytes.subarray(33)]);
    await expect(normalizeBrandingImage(input(animated))).rejects.toBeInstanceOf(
      BrandingImageError,
    );
  });

  test("rejects duplicate PNG headers before decoding", async () => {
    const bytes = await image("png");
    const duplicate = Buffer.concat([
      bytes.subarray(0, 33),
      bytes.subarray(8, 33),
      bytes.subarray(33),
    ]);
    await expect(normalizeBrandingImage(input(duplicate))).rejects.toBeInstanceOf(
      BrandingImageError,
    );
  });

  test("rejects an oversized PNG header before decoding", async () => {
    const bytes = await image("png");
    bytes.writeUInt32BE(2500, 16);
    bytes.writeUInt32BE(2000, 20);
    await expect(normalizeBrandingImage(input(bytes))).rejects.toBeInstanceOf(BrandingImageError);
  });

  test("rejects animated WebP instead of silently saving its first frame", async () => {
    const frames = Buffer.concat([Buffer.alloc(4 * 4 * 4, 127), Buffer.alloc(4 * 4 * 4, 255)]);
    const bytes = await sharp(frames, {
      raw: { width: 4, height: 8, channels: 4, pageHeight: 4 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(bytes).metadata()).pages).toBe(2);
    await expect(normalizeBrandingImage(input(bytes, "image/webp"))).rejects.toBeInstanceOf(
      BrandingImageError,
    );
  });

  test("rejects WebP frame dimensions that conflict with its extended canvas", async () => {
    const bytes = webpWithCanvas(await image("webp", 4, 4), 3, 3);
    await expect(normalizeBrandingImage(input(bytes, "image/webp"))).rejects.toBeInstanceOf(
      BrandingImageError,
    );
  });
});

describe("tenant branding app icon admission", () => {
  test("creates canonical square app icons", async () => {
    const icons = await normalizeBrandingAppIcon(input(await image("png", 1024, 1024)));
    expect(await sharp(icons.icon_192).metadata()).toMatchObject({
      format: "png",
      width: 192,
      height: 192,
    });
    expect(await sharp(icons.icon_512).metadata()).toMatchObject({
      format: "png",
      width: 512,
      height: 512,
    });
  });

  test("rejects undersized and non-square app icons", async () => {
    await expect(
      normalizeBrandingAppIcon(input(await image("png", 511, 511))),
    ).rejects.toBeInstanceOf(BrandingImageError);
    await expect(
      normalizeBrandingAppIcon(input(await image("png", 512, 256))),
    ).rejects.toBeInstanceOf(BrandingImageError);
  });
});
