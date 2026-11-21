import { deflateSync, inflateSync } from "node:zlib";
import type { Rect } from "@shared/local-policy/redaction-rects.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 8192 * 8192;

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

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly pixels: Uint8Array;
}

export class PngError extends Error {}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new PngError("image data has the wrong size");
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x] as number;
      const left = x >= channels ? (out[row + x - channels] as number) : 0;
      const up = y > 0 ? (out[row - stride + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (out[row - stride + x - channels] as number) : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >>> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else if (filter !== 0) throw new PngError("unknown filter");
      out[row + x] = (value + predicted) & 0xff;
    }
  }
  return out;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE))
    throw new PngError("not a PNG");
  let offset = 8;
  let header: { width: number; height: number; channels: 3 | 4 } | null = null;
  const data: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new PngError("truncated chunk");
    if (type === "IHDR") {
      const width = body.readUInt32BE(0);
      const height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      const interlace = body[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0)
        throw new PngError("unsupported PNG layout");
      if (width === 0 || height === 0 || width * height > MAX_PIXELS)
        throw new PngError("unsupported PNG size");
      header = { width, height, channels: color === 6 ? 4 : 3 };
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (header === null || data.length === 0) throw new PngError("missing image data");
  const raw = inflateSync(Buffer.concat(data));
  return { ...header, pixels: unfilter(raw, header.width, header.height, header.channels) };
}

export function encodePng(image: DecodedImage): Buffer {
  const stride = image.width * image.channels;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = image.channels === 4 ? 6 : 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

export function paintRects(image: DecodedImage, rects: readonly Rect[]): DecodedImage {
  const pixels = new Uint8Array(image.pixels);
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * image.width + x) * image.channels;
        pixels[at] = 0;
        pixels[at + 1] = 0;
        pixels[at + 2] = 0;
        if (image.channels === 4) pixels[at + 3] = 255;
      }
    }
  }
  return { ...image, pixels };
}

export function redactPng(bytes: Uint8Array, rects: readonly Rect[]): Buffer {
  return encodePng(paintRects(decodePng(bytes), rects));
}
