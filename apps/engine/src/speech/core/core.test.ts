import { describe, expect, test } from "bun:test";
import { audioRefusal, baseContentType, SPEECH_MAX_BYTES } from "./limits.ts";
import { LOCAL_SPEECH_FILES, modelFileForUrl, modelFileUrl } from "./model-files.ts";
import { finalTranscript } from "./transcript.ts";
import { decodePcmWav, resampleLinear, wavSeconds } from "./wav.ts";

function pcmWav(samples: readonly number[], sampleRate: number, channels = 1): Uint8Array {
  const data = samples.length * 2;
  const buffer = new ArrayBuffer(44 + data);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (const [index, char] of [...text].entries())
      view.setUint8(offset + index, char.charCodeAt(0));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, data, true);
  for (const [index, sample] of samples.entries()) view.setInt16(44 + index * 2, sample, true);
  return new Uint8Array(buffer);
}

describe("audioRefusal", () => {
  test("accepts supported audio with codec parameters", () => {
    expect(audioRefusal("audio/webm;codecs=opus", 10)).toBeNull();
    expect(baseContentType("audio/x-wav")).toBe("audio/wav");
  });

  test("refuses unsupported, empty and oversized recordings with distinct codes", () => {
    expect(audioRefusal("video/mp4", 10)?.code).toBe("unsupported_audio");
    expect(audioRefusal("audio/wav", 0)?.code).toBe("audio_empty");
    expect(audioRefusal("audio/wav", SPEECH_MAX_BYTES + 1)?.status).toBe(413);
  });
});

describe("finalTranscript", () => {
  test("collapses whitespace and trims", () => {
    expect(finalTranscript("  hello \n world  ")).toEqual({ kind: "text", text: "hello world" });
  });

  test("treats empty text and silence markers as no speech", () => {
    expect(finalTranscript("   ")).toEqual({ kind: "no_speech" });
    expect(finalTranscript(" [BLANK_AUDIO] ")).toEqual({ kind: "no_speech" });
    expect(finalTranscript("...")).toEqual({ kind: "no_speech" });
  });
});

describe("decodePcmWav", () => {
  test("decodes 16-bit mono PCM to floats", () => {
    const result = decodePcmWav(pcmWav([0, 16384, -32768], 16000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audio.sampleRate).toBe(16000);
    expect([...result.audio.samples]).toEqual([0, 0.5, -1]);
  });

  test("downmixes stereo by averaging channels", () => {
    const result = decodePcmWav(pcmWav([16384, 0, -16384, -16384], 8000, 2));
    expect(result.ok && [...result.audio.samples]).toEqual([0.25, -0.5]);
  });

  test("refuses formats other than 16-bit PCM", () => {
    const eightBit = pcmWav([0, 0], 16000);
    new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(decodePcmWav(eightBit)).toEqual({ ok: false, reason: "unsupported_format" });
  });

  test("skips other chunks and reports a header without audio as truncated", () => {
    const headerOnly = pcmWav([], 16000).subarray(0, 36);
    expect(decodePcmWav(headerOnly)).toEqual({ ok: false, reason: "truncated" });
  });

  test("rejects non-wav and truncated input", () => {
    expect(decodePcmWav(new TextEncoder().encode("OggS-not-a-wav"))).toEqual({
      ok: false,
      reason: "not_wav",
    });
    expect(decodePcmWav(new Uint8Array(4))).toEqual({ ok: false, reason: "truncated" });
  });
});

describe("resampleLinear", () => {
  test("halves the sample count when downsampling by two", () => {
    const samples = new Float32Array([0, 1, 0, -1]);
    expect([...resampleLinear({ sampleRate: 32000, samples }, 16000)]).toEqual([0, 0]);
  });

  test("returns the same samples at the target rate", () => {
    const samples = new Float32Array([0.5]);
    expect(resampleLinear({ sampleRate: 16000, samples }, 16000)).toBe(samples);
  });
});

describe("model files", () => {
  test("every pinned file resolves back from its own url", () => {
    for (const file of LOCAL_SPEECH_FILES) expect(modelFileForUrl(modelFileUrl(file))).toBe(file);
  });

  test("an unknown file does not resolve", () => {
    expect(
      modelFileForUrl("https://huggingface.co/onnx-community/whisper-base/resolve/main/x.bin"),
    ).toBeUndefined();
  });
});

describe("wavSeconds", () => {
  test("measures a recording from its frames and sample rate", () => {
    expect(wavSeconds(pcmWav(new Array(8000).fill(0), 16000))).toBe(0.5);
    expect(wavSeconds(pcmWav(new Array(16000).fill(0), 8000, 2))).toBe(1);
  });

  test("knows no length for anything but PCM WAV", () => {
    expect(wavSeconds(new TextEncoder().encode("OggS-not-a-wav"))).toBeUndefined();
  });
});
