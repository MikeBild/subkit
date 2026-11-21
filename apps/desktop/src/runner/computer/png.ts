import { deflateSync, inflateSync } from "node:zlib";
import type { Rect } from "@shared/local-policy/redaction-rects.ts";

export const PNG_MAX_PIXELS = 100_000_000;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function unfilter(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array | null {
  const stride = width * bpp;
  if (data.length !== height * (stride + 1)) return null;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * (stride + 1)];
    const row = y * stride;
    const source = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[source + x] as number;
      const left = x >= bpp ? (out[row + x - bpp] as number) : 0;
      const up = y > 0 ? (out[row - stride + x] as number) : 0;
      const upLeft = x >= bpp && y > 0 ? (out[row - stride + x - bpp] as number) : 0;
      let value: number;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else return null;
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

export function decodePng(bytes: Uint8Array): RgbaImage | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8;
  let header: { width: number; height: number; bpp: number } | null = null;
  const parts: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return null;
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (
      buffer.readUInt32BE(offset + 8 + length) !==
      crc32(buffer.subarray(offset + 4, offset + 8 + length))
    ) {
      return null;
    }
    if (type === "IHDR") {
      const [depth, color, compression, filter, interlace] = body.subarray(8, 13);
      if (depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return null;
      if (color !== 2 && color !== 6) return null;
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bpp: color === 6 ? 4 : 3,
      };
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
    offset = end;
  }
  if (!header || header.width === 0 || header.height === 0) return null;
  if (header.width * header.height > PNG_MAX_PIXELS) return null;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(parts), {
      maxOutputLength: header.height * (header.width * header.bpp + 1),
    });
  } catch {
    return null;
  }
  const raw = unfilter(inflated, header.width, header.height, header.bpp);
  if (!raw) return null;
  if (header.bpp === 4) return { width: header.width, height: header.height, pixels: raw };
  const pixels = new Uint8Array(header.width * header.height * 4);
  for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
    pixels[j] = raw[i] as number;
    pixels[j + 1] = raw[i + 1] as number;
    pixels[j + 2] = raw[i + 2] as number;
    pixels[j + 3] = 255;
  }
  return { width: header.width, height: header.height, pixels };
}

export function blackOut(image: RgbaImage, rects: readonly Rect[]): RgbaImage {
  const pixels = new Uint8Array(image.pixels);
  for (const rect of rects) {
    const left = Math.max(0, Math.floor(rect.x));
    const top = Math.max(0, Math.floor(rect.y));
    const right = Math.min(image.width, Math.ceil(rect.x + rect.width));
    const bottom = Math.min(image.height, Math.ceil(rect.y + rect.height));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const at = (y * image.width + x) * 4;
        pixels[at] = 0;
        pixels[at + 1] = 0;
        pixels[at + 2] = 0;
        pixels[at + 3] = 255;
      }
    }
  }
  return { ...image, pixels };
}

export function downscale(image: RgbaImage, width: number, height: number): RgbaImage {
  if (width === image.width && height === image.height) return image;
  const pixels = new Uint8Array(width * height * 4);
  const stepX = image.width / width;
  const stepY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const fromY = Math.floor(y * stepY);
    const toY = Math.max(fromY + 1, Math.min(image.height, Math.ceil((y + 1) * stepY)));
    for (let x = 0; x < width; x += 1) {
      const fromX = Math.floor(x * stepX);
      const toX = Math.max(fromX + 1, Math.min(image.width, Math.ceil((x + 1) * stepX)));
      const sums = [0, 0, 0, 0];
      for (let sy = fromY; sy < toY; sy += 1) {
        for (let sx = fromX; sx < toX; sx += 1) {
          const at = (sy * image.width + sx) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            sums[channel] = (sums[channel] as number) + (image.pixels[at + channel] as number);
          }
        }
      }
      const count = (toY - fromY) * (toX - fromX);
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[at + channel] = Math.round((sums[channel] as number) / count);
      }
    }
  }
  return { width, height, pixels };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng(image: RgbaImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) {
    raw.set(image.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
