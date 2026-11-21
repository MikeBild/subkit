import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { blackOut, decodePng, downscale, encodePng, type RgbaImage } from "./png.ts";

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
  return { width, height, pixels };
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.pixels.subarray(at, at + 4)];
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function chunk(type: string, body: Buffer): Buffer {
  const table = crcTable();
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), body])) {
    crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

function rgbPng(width: number, height: number, rows: Buffer[], color = 2, depth = 8): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, color, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("png round trip", () => {
  test("encodes and decodes RGBA", () => {
    const image = solid(3, 2, [10, 20, 30, 255]);
    const decoded = decodePng(encodePng(image));
    expect(decoded?.width).toBe(3);
    expect(decoded?.height).toBe(2);
    expect([...(decoded?.pixels ?? [])]).toEqual([...image.pixels]);
  });

  test("decodes RGB with every filter type", () => {
    const rows = [
      Buffer.from([0, 1, 2, 3, 4, 5, 6]),
      Buffer.from([1, 1, 1, 1, 1, 1, 1]),
      Buffer.from([2, 1, 1, 1, 1, 1, 1]),
      Buffer.from([3, 2, 2, 2, 2, 2, 2]),
      Buffer.from([4, 1, 1, 1, 1, 1, 1]),
    ];
    const decoded = decodePng(rgbPng(2, 5, rows));
    expect(decoded).not.toBeNull();
    const image = decoded as RgbaImage;
    expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(pixel(image, 1, 0)).toEqual([4, 5, 6, 255]);
    expect(pixel(image, 0, 1)).toEqual([1, 1, 1, 255]);
    expect(pixel(image, 1, 1)).toEqual([2, 2, 2, 255]);
    expect(pixel(image, 0, 2)).toEqual([2, 2, 2, 255]);
    expect(pixel(image, 1, 2)).toEqual([3, 3, 3, 255]);
    expect(pixel(image, 0, 3)).toEqual([3, 3, 3, 255]);
    expect(pixel(image, 1, 3)).toEqual([5, 5, 5, 255]);
    expect(pixel(image, 0, 4)).toEqual([4, 4, 4, 255]);
    expect(pixel(image, 1, 4)).toEqual([6, 6, 6, 255]);
  });

  test("fails closed on everything it does not support", () => {
    expect(decodePng(Buffer.from("not a png"))).toBeNull();
    expect(decodePng(rgbPng(1, 1, [Buffer.from([0, 0, 0, 0, 0, 0, 0])], 2, 16))).toBeNull();
    expect(decodePng(rgbPng(1, 1, [Buffer.from([0, 0])], 0))).toBeNull();
    expect(decodePng(rgbPng(1, 1, [Buffer.from([9, 0, 0, 0])]))).toBeNull();
    expect(decodePng(rgbPng(1, 1, [Buffer.from([0, 0, 0])]))).toBeNull();
    const broken = encodePng(solid(1, 1, [1, 1, 1, 1]));
    broken.writeUInt8((broken.readUInt8(broken.length - 20) ^ 0xff) & 0xff, broken.length - 20);
    expect(decodePng(broken)).toBeNull();
    expect(decodePng(encodePng(solid(2, 2, [1, 1, 1, 1])).subarray(0, 40))).toBeNull();
  });
});

describe("blackOut", () => {
  test("paints the rectangles opaque black and leaves the rest", () => {
    const out = blackOut(solid(4, 4, [255, 255, 255, 255]), [{ x: 1, y: 1, width: 2, height: 2 }]);
    expect(pixel(out, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 2, 2)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 3, 3)).toEqual([255, 255, 255, 255]);
  });

  test("clips to the image and rounds outward", () => {
    const out = blackOut(solid(2, 2, [9, 9, 9, 0]), [{ x: -5, y: 0.5, width: 5.2, height: 10 }]);
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 0, 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 1, 1)).toEqual([9, 9, 9, 0]);
  });

  test("does not change the source image", () => {
    const source = solid(1, 1, [5, 5, 5, 5]);
    blackOut(source, [{ x: 0, y: 0, width: 1, height: 1 }]);
    expect(pixel(source, 0, 0)).toEqual([5, 5, 5, 5]);
  });
});

describe("downscale", () => {
  test("averages blocks and keeps black areas black", () => {
    const image = blackOut(solid(4, 4, [200, 200, 200, 255]), [
      { x: 0, y: 0, width: 2, height: 4 },
    ]);
    const small = downscale(image, 2, 2);
    expect(pixel(small, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(small, 1, 1)).toEqual([200, 200, 200, 255]);
  });

  test("returns the same image when the size is unchanged", () => {
    const image = solid(2, 2, [1, 2, 3, 4]);
    expect(downscale(image, 2, 2)).toBe(image);
  });

  test("handles uneven factors", () => {
    const small = downscale(solid(3, 3, [90, 90, 90, 255]), 2, 2);
    expect(small.width).toBe(2);
    expect(pixel(small, 1, 1)).toEqual([90, 90, 90, 255]);
  });
});
