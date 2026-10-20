import jpegDecoderWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm" with { type: "file" };
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
// @ts-expect-error Bundles the codec as a file despite its generated Emscripten type declaration.
import pngCodecWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" with { type: "file" };
import decodePng, { init as initPngDecode } from "@jsquash/png/decode.js";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode.js";
import resize, { initResize } from "@jsquash/resize";
// @ts-expect-error Bundles the codec as a file despite its generated Emscripten type declaration.
import resizeWasm from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm" with {
  type: "file",
};
import webpDecoderWasm from "@jsquash/webp/codec/dec/webp_dec.wasm" with { type: "file" };
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";

export const BRANDING_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const BRANDING_IMAGE_MAX_PIXELS = 4_000_000;
export const BRANDING_IMAGE_MAX_EDGE = 512;
export const BRANDING_IMAGE_MAX_BASE64 = Math.ceil(BRANDING_IMAGE_MAX_BYTES / 3) * 4;

type ImageFormat = "image/png" | "image/jpeg" | "image/webp";
type ImageDetails = { format: ImageFormat; width: number; height: number; orientation: number };

export class BrandingImageError extends Error {
  readonly code = "branding_image_invalid";
  constructor() {
    super("Use a valid, still PNG, JPEG or WebP image up to 2 MiB and 4 megapixels.");
    this.name = "BrandingImageError";
  }
}

let codecs: Promise<void> | undefined;

function fail(): never {
  throw new BrandingImageError();
}
function byte(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) fail();
  return value;
}
function u16be(bytes: Uint8Array, offset: number): number {
  return (byte(bytes, offset) << 8) | byte(bytes, offset + 1);
}
function u16le(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) | (byte(bytes, offset + 1) << 8);
}
function u32be(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) * 0x1000000 +
    (byte(bytes, offset + 1) << 16) +
    (byte(bytes, offset + 2) << 8) +
    byte(bytes, offset + 3)
  );
}
function u32le(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) +
    byte(bytes, offset + 1) * 0x100 +
    byte(bytes, offset + 2) * 0x10000 +
    byte(bytes, offset + 3) * 0x1000000
  );
}
function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    byte(bytes, offset),
    byte(bytes, offset + 1),
    byte(bytes, offset + 2),
    byte(bytes, offset + 3),
  );
}
function dimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > BRANDING_IMAGE_MAX_PIXELS ||
    height > BRANDING_IMAGE_MAX_PIXELS ||
    width * height > BRANDING_IMAGE_MAX_PIXELS
  )
    fail();
}

function parsePng(bytes: Uint8Array): ImageDetails {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => byte(bytes, index) === value)) fail();
  let offset = 8;
  let header: { width: number; height: number } | undefined;
  let ended = false;
  while (offset < bytes.length) {
    if (ended || offset + 12 > bytes.length) fail();
    const length = u32be(bytes, offset);
    const type = fourcc(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) fail();
    if (type === "IHDR") {
      if (header || offset !== 8 || length !== 13) fail();
      const width = u32be(bytes, start);
      const height = u32be(bytes, start + 4);
      dimensions(width, height);
      header = { width, height };
    }
    if (type === "acTL") fail();
    if (type === "IEND") {
      if (!header || length !== 0 || end + 4 !== bytes.length) fail();
      ended = true;
    }
    offset = end + 4;
  }
  if (!header || !ended) fail();
  return { format: "image/png", ...header, orientation: 1 };
}

function exifOrientation(bytes: Uint8Array): number {
  if (
    bytes.length < 14 ||
    fourcc(bytes, 0) !== "Exif" ||
    byte(bytes, 4) !== 0 ||
    byte(bytes, 5) !== 0
  )
    return 1;
  const start = 6;
  const little = byte(bytes, start) === 73 && byte(bytes, start + 1) === 73;
  const big = byte(bytes, start) === 77 && byte(bytes, start + 1) === 77;
  if (!little && !big) fail();
  const u16 = little ? u16le : u16be;
  const u32 = little ? u32le : u32be;
  if (u16(bytes, start + 2) !== 42) fail();
  const ifd = start + u32(bytes, start + 4);
  const count = u16(bytes, ifd);
  if (count > 256 || ifd + 2 + count * 12 + 4 > bytes.length) fail();
  let orientation = 1;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (u16(bytes, entry) !== 0x0112) continue;
    if (u16(bytes, entry + 2) !== 3 || u32(bytes, entry + 4) !== 1 || orientation !== 1) fail();
    const value = u16(bytes, entry + 8);
    if (value < 1 || value > 8) fail();
    orientation = value;
  }
  return orientation;
}

function sof(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}
function parseJpeg(bytes: Uint8Array): ImageDetails {
  if (bytes.length < 4 || byte(bytes, 0) !== 0xff || byte(bytes, 1) !== 0xd8) fail();
  let offset = 2;
  let size: { width: number; height: number } | undefined;
  let orientation = 1;
  let exif = false;
  while (offset < bytes.length) {
    if (byte(bytes, offset) !== 0xff) fail();
    while (byte(bytes, offset) === 0xff) offset += 1;
    if (offset >= bytes.length) fail();
    const marker = byte(bytes, offset++);
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) fail();
    const start = offset + 2;
    const end = offset + length;
    if (sof(marker)) {
      if (size || length < 8) fail();
      const height = u16be(bytes, start + 1);
      const width = u16be(bytes, start + 3);
      dimensions(width, height);
      size = { width, height };
    }
    if (marker === 0xe1 && end - start >= 6 && fourcc(bytes, start) === "Exif") {
      if (exif) fail();
      orientation = exifOrientation(bytes.subarray(start, end));
      exif = true;
    }
    offset = end;
  }
  if (!size) fail();
  return { format: "image/jpeg", ...size, orientation };
}

function webpFrame(bytes: Uint8Array, type: string, offset: number, length: number) {
  if (type === "VP8 ") {
    if (
      length < 10 ||
      byte(bytes, offset + 3) !== 0x9d ||
      byte(bytes, offset + 4) !== 0x01 ||
      byte(bytes, offset + 5) !== 0x2a
    )
      fail();
    return { width: u16le(bytes, offset + 6) & 0x3fff, height: u16le(bytes, offset + 8) & 0x3fff };
  }
  if (type === "VP8L") {
    if (length < 5 || byte(bytes, offset) !== 0x2f) fail();
    const bits = u32le(bytes, offset + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  fail();
}
function parseWebp(bytes: Uint8Array): ImageDetails {
  if (
    bytes.length < 20 ||
    fourcc(bytes, 0) !== "RIFF" ||
    fourcc(bytes, 8) !== "WEBP" ||
    u32le(bytes, 4) !== bytes.length - 8
  )
    fail();
  let offset = 12;
  let canvas: { width: number; height: number } | undefined;
  let frame: { width: number; height: number } | undefined;
  let extended = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail();
    const type = fourcc(bytes, offset);
    const length = u32le(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) fail();
    if (type === "VP8X") {
      if (extended || length !== 10) fail();
      extended = true;
      if ((byte(bytes, start) & 0x02) !== 0) fail();
      canvas = {
        width:
          byte(bytes, start + 4) +
          (byte(bytes, start + 5) << 8) +
          (byte(bytes, start + 6) << 16) +
          1,
        height:
          byte(bytes, start + 7) +
          (byte(bytes, start + 8) << 8) +
          (byte(bytes, start + 9) << 16) +
          1,
      };
      dimensions(canvas.width, canvas.height);
    }
    if (type === "ANIM" || type === "ANMF") fail();
    if (type === "VP8 " || type === "VP8L") {
      if (frame) fail();
      frame = webpFrame(bytes, type, start, length);
      dimensions(frame.width, frame.height);
    }
    offset = end + (length % 2);
  }
  if (
    !frame ||
    offset !== bytes.length ||
    (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))
  )
    fail();
  return { format: "image/webp", ...(canvas ?? frame), orientation: 1 };
}
function parseImage(bytes: Uint8Array): ImageDetails {
  if (bytes.length >= 8 && byte(bytes, 0) === 137 && byte(bytes, 1) === 80) return parsePng(bytes);
  if (bytes.length >= 2 && byte(bytes, 0) === 0xff && byte(bytes, 1) === 0xd8)
    return parseJpeg(bytes);
  if (bytes.length >= 12 && fourcc(bytes, 0) === "RIFF" && fourcc(bytes, 8) === "WEBP")
    return parseWebp(bytes);
  fail();
}
function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
function imageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  return { data, width, height } as ImageData;
}

function orient(source: ImageData, orientation: number): ImageData {
  if (orientation === 1) return source;
  const width = orientation >= 5 ? source.height : source.width;
  const height = orientation >= 5 ? source.width : source.height;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < source.height; y += 1)
    for (let x = 0; x < source.width; x += 1) {
      let dx = x;
      let dy = y;
      if (orientation === 2) dx = source.width - 1 - x;
      if (orientation === 3) {
        dx = source.width - 1 - x;
        dy = source.height - 1 - y;
      }
      if (orientation === 4) dy = source.height - 1 - y;
      if (orientation === 5) {
        dx = y;
        dy = x;
      }
      if (orientation === 6) {
        dx = source.height - 1 - y;
        dy = x;
      }
      if (orientation === 7) {
        dx = source.height - 1 - y;
        dy = source.width - 1 - x;
      }
      if (orientation === 8) {
        dx = y;
        dy = source.width - 1 - x;
      }
      output.set(
        source.data.subarray((y * source.width + x) * 4, (y * source.width + x + 1) * 4),
        (dy * width + dx) * 4,
      );
    }
  return imageData(output, width, height);
}
function outputSize(width: number, height: number) {
  const scale = Math.min(1, BRANDING_IMAGE_MAX_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
async function initializeCodecs(): Promise<void> {
  const [jpeg, png, webp, resizer] = await Promise.all([
    Bun.file(jpegDecoderWasm).arrayBuffer(),
    Bun.file(pngCodecWasm).arrayBuffer(),
    Bun.file(webpDecoderWasm).arrayBuffer(),
    Bun.file(resizeWasm).arrayBuffer(),
  ]);
  await Promise.all([
    initJpegDecode(new WebAssembly.Module(jpeg)),
    initPngDecode(new WebAssembly.Module(png)),
    initPngEncode(new WebAssembly.Module(png)),
    initWebpDecode(new WebAssembly.Module(webp)),
    initResize(new WebAssembly.Module(resizer)),
  ]);
}
async function decode(bytes: Uint8Array, details: ImageDetails): Promise<ImageData> {
  codecs ??= initializeCodecs();
  await codecs;
  const source = copyBuffer(bytes);
  if (details.format === "image/png") return decodePng(source);
  if (details.format === "image/jpeg") return decodeJpeg(source, { preserveOrientation: false });
  return decodeWebp(source);
}

export async function normalizeBrandingImage(input: {
  mime_type: string;
  content_base64: string;
}): Promise<Uint8Array> {
  try {
    if (
      typeof input.content_base64 !== "string" ||
      input.content_base64.length === 0 ||
      input.content_base64.length > BRANDING_IMAGE_MAX_BASE64 ||
      input.content_base64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(input.content_base64)
    )
      fail();
    const bytes = Buffer.from(input.content_base64, "base64");
    if (
      bytes.length > BRANDING_IMAGE_MAX_BYTES ||
      bytes.toString("base64") !== input.content_base64
    )
      fail();
    const details = parseImage(bytes);
    if (details.format !== input.mime_type) fail();
    const oriented = orient(await decode(bytes, details), details.orientation);
    dimensions(oriented.width, oriented.height);
    const target = outputSize(oriented.width, oriented.height);
    const normalized =
      target.width === oriented.width && target.height === oriented.height
        ? oriented
        : await resize(oriented, { ...target, method: "lanczos3" });
    return new Uint8Array(await encodePng(normalized));
  } catch {
    throw new BrandingImageError();
  }
}
