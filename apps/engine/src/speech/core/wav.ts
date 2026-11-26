export interface PcmAudio {
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

export type WavDecodeResult =
  | { readonly ok: true; readonly audio: PcmAudio }
  | { readonly ok: false; readonly reason: "not_wav" | "unsupported_format" | "truncated" };

interface WavFormat {
  readonly code: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bits: number;
}

const ascii = (view: DataView, offset: number): string =>
  String.fromCharCode(...[0, 1, 2, 3].map((index) => view.getUint8(offset + index)));

const readFormat = (view: DataView, body: number): WavFormat => ({
  code: view.getUint16(body, true),
  channels: view.getUint16(body + 2, true),
  sampleRate: view.getUint32(body + 4, true),
  bits: view.getUint16(body + 14, true),
});

function monoSamples(view: DataView, body: number, size: number, format: WavFormat): Float32Array {
  const available = Math.min(size, view.byteLength - body);
  const frames = Math.floor(available / (2 * format.channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel++)
      sum += view.getInt16(body + (frame * format.channels + channel) * 2, true);
    samples[frame] = sum / format.channels / 32768;
  }
  return samples;
}

export function decodePcmWav(bytes: Uint8Array): WavDecodeResult {
  if (bytes.byteLength < 12) return { ok: false, reason: "truncated" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE")
    return { ok: false, reason: "not_wav" };
  let offset = 12;
  let format: WavFormat | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) return { ok: false, reason: "truncated" };
      format = readFormat(view, body);
    }
    if (id === "data") {
      if (format?.code !== 1 || format.bits !== 16 || format.channels < 1)
        return { ok: false, reason: "unsupported_format" };
      return {
        ok: true,
        audio: { sampleRate: format.sampleRate, samples: monoSamples(view, body, size, format) },
      };
    }
    offset = body + size + (size % 2);
  }
  return { ok: false, reason: "truncated" };
}

export function wavSeconds(bytes: Uint8Array): number | undefined {
  const decoded = decodePcmWav(bytes);
  if (!decoded.ok || decoded.audio.sampleRate <= 0) return undefined;
  return decoded.audio.samples.length / decoded.audio.sampleRate;
}

export function resampleLinear(audio: PcmAudio, targetRate: number): Float32Array {
  if (audio.sampleRate === targetRate) return audio.samples;
  const ratio = audio.sampleRate / targetRate;
  const length = Math.floor(audio.samples.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, audio.samples.length - 1);
    const weight = position - left;
    output[index] =
      (audio.samples[left] ?? 0) * (1 - weight) + (audio.samples[right] ?? 0) * weight;
  }
  return output;
}
