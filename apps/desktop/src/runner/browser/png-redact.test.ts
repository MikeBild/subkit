import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  type DecodedImage,
  decodePng,
  encodePng,
  PngError,
  paintRects,
  redactPng,
} from "./png-redact.ts";

function gradient(width: number, height: number, channels: 3 | 4): DecodedImage {
  const pixels = new Uint8Array(width * height * channels);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 37 + 11) % 251;
  return { width, height, channels, pixels };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filtered(image: DecodedImage): Buffer {
  const stride = image.width * image.channels;
  const raw = Buffer.alloc(image.height * (stride + 1));
  const px = image.pixels;
  for (let y = 0; y < image.height; y += 1) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const at = y * stride + x;
      const left = x >= image.channels ? (px[at - image.channels] as number) : 0;
      const up = y > 0 ? (px[at - stride] as number) : 0;
      const upLeft =
        y > 0 && x >= image.channels ? (px[at - stride - image.channels] as number) : 0;
      const predicted = [0, left, up, (left + up) >>> 1, paeth(left, up, upLeft)][filter] as number;
      raw[y * (stride + 1) + 1 + x] = ((px[at] as number) - predicted) & 0xff;
    }
  }
  const encoded = encodePng(image);
  const idatStart = encoded.indexOf(Buffer.from("IDAT")) - 4;
  const idatLength = encoded.readUInt32BE(idatStart);
  const head = encoded.subarray(0, idatStart);
  const tail = encoded.subarray(idatStart + 12 + idatLength);
  const data = deflateSync(raw);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  return Buffer.concat([head, length, Buffer.from("IDAT"), data, crc, tail]);
}

describe("PNG redaction", () => {
  test("encode and decode round trip for RGB and RGBA", () => {
    for (const channels of [3, 4] as const) {
      const image = gradient(7, 5, channels);
      const decoded = decodePng(encodePng(image));
      expect(decoded.width).toBe(7);
      expect(decoded.height).toBe(5);
      expect(decoded.channels).toBe(channels);
      expect([...decoded.pixels]).toEqual([...image.pixels]);
    }
  });

  test("every PNG row filter decodes to the same pixels", () => {
    for (const channels of [3, 4] as const) {
      const image = gradient(9, 10, channels);
      expect([...decodePng(filtered(image)).pixels]).toEqual([...image.pixels]);
    }
  });

  test("rects are painted black, clipped to the image, others untouched", () => {
    const image = gradient(4, 3, 4);
    const painted = paintRects(image, [{ x: 2.5, y: -1, width: 9, height: 2 }]);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const at = (y * 4 + x) * 4;
        const inside = x >= 2 && y < 1;
        const pixel = [...painted.pixels.subarray(at, at + 4)];
        if (inside) expect(pixel).toEqual([0, 0, 0, 255]);
        else expect(pixel).toEqual([...image.pixels.subarray(at, at + 4)]);
      }
    }
    expect([...image.pixels.subarray(8, 12)]).not.toEqual([0, 0, 0, 255]);
  });

  test("redactPng re-encodes without metadata chunks", () => {
    const image = gradient(3, 3, 3);
    const encoded = encodePng(image);
    const text = Buffer.concat([
      encoded.subarray(0, 33),
      Buffer.from([0, 0, 0, 4]),
      Buffer.from("tEXtsecr"),
      Buffer.alloc(4),
      encoded.subarray(33),
    ]);
    const out = redactPng(text, [{ x: 0, y: 0, width: 1, height: 1 }]);
    expect(out.includes(Buffer.from("tEXt"))).toBe(false);
    const decoded = decodePng(out);
    expect([...decoded.pixels.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...decoded.pixels.subarray(3)]).toEqual([...image.pixels.subarray(3)]);
  });

  test("unsupported or broken input throws a PNG error", () => {
    expect(() => decodePng(Buffer.from("nope"))).toThrow(PngError);
    const image = encodePng(gradient(2, 2, 3));
    const sixteenBit = Buffer.from(image);
    sixteenBit[24] = 16;
    expect(() => decodePng(sixteenBit)).toThrow("unsupported PNG layout");
    const noData = Buffer.concat([image.subarray(0, 33), image.subarray(image.length - 12)]);
    expect(() => decodePng(noData)).toThrow("missing image data");
    expect(() => decodePng(image.subarray(0, 20))).toThrow(PngError);
  });
});
