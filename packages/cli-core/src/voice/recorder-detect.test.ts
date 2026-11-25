import { describe, expect, test } from "bun:test";
import {
  parseDshowAudioDevices,
  pcmToWav,
  type RecorderTool,
  recorderCommand,
  recorderInstallHint,
  spokenLanguageFromEnv,
} from "./recorder-detect.ts";

const having =
  (...tools: RecorderTool[]) =>
  (tool: RecorderTool) =>
    tools.includes(tool) ? `/bin/${tool}` : null;

describe("recorderCommand", () => {
  test("prefers rec and records raw 16 kHz mono PCM to stdout", () => {
    expect(recorderCommand({ platform: "darwin", which: having("rec", "ffmpeg") })).toEqual({
      tool: "rec",
      command: "/bin/rec",
      args: ["-q", "-t", "raw", "-e", "signed-integer", "-b", "16", "-c", "1", "-r", "16000", "-"],
      stop: "kill",
    });
  });

  test("uses the default device with sox and waveaudio on Windows", () => {
    expect(recorderCommand({ platform: "linux", which: having("sox") })?.args.slice(0, 2)).toEqual([
      "-q",
      "-d",
    ]);
    expect(recorderCommand({ platform: "win32", which: having("sox") })?.args.slice(1, 4)).toEqual([
      "-t",
      "waveaudio",
      "default",
    ]);
  });

  test("picks the ffmpeg input per platform and stops it with q", () => {
    const mac = recorderCommand({ platform: "darwin", which: having("ffmpeg") });
    expect(mac?.stop).toBe("stdin-q");
    expect(mac?.args).toContain(":default");
    expect(recorderCommand({ platform: "linux", which: having("ffmpeg") })?.args).toContain(
      "pulse",
    );
    expect(
      recorderCommand({ platform: "win32", which: having("ffmpeg"), device: "Mic (USB)" })?.args,
    ).toContain("audio=Mic (USB)");
  });

  test("ffmpeg on Windows needs a named device", () => {
    expect(recorderCommand({ platform: "win32", which: having("ffmpeg") })).toBeNull();
  });

  test("falls back to arecord only on Linux", () => {
    expect(recorderCommand({ platform: "linux", which: having("arecord") })?.tool).toBe("arecord");
    expect(recorderCommand({ platform: "darwin", which: having("arecord") })).toBeNull();
  });

  test("returns null when no recorder is installed and names one per platform", () => {
    expect(recorderCommand({ platform: "darwin", which: having() })).toBeNull();
    expect(recorderInstallHint("darwin")).toContain("brew install sox");
    expect(recorderInstallHint("win32")).toContain("winget");
    expect(recorderInstallHint("linux")).toContain("apt");
  });
});

describe("parseDshowAudioDevices", () => {
  test("lists the audio devices ffmpeg reports", () => {
    const stderr = [
      '[dshow @ 0x1] "Integrated Camera" (video)',
      '[dshow @ 0x1] "Microphone Array (Realtek(R) Audio)" (audio)',
      '[dshow @ 0x1]   Alternative name "@device_cm_{33D9A762}"',
      '[dshow @ 0x1] "Headset Mic (USB)" (audio)',
    ].join("\n");
    expect(parseDshowAudioDevices(stderr)).toEqual([
      "Microphone Array (Realtek(R) Audio)",
      "Headset Mic (USB)",
    ]);
  });
});

describe("spokenLanguageFromEnv", () => {
  test("prefers the explicit dictation language, then the locale variables", () => {
    expect(
      spokenLanguageFromEnv({ SUBKIT_DICTATION_LANGUAGE: "fr", LANG: "de_DE.UTF-8" }, "en"),
    ).toBe("fr");
    expect(spokenLanguageFromEnv({ LANG: "de_DE.UTF-8" }, "en-US")).toBe("de");
    expect(spokenLanguageFromEnv({}, "en-US")).toBe("en");
  });

  test("the C and POSIX locales carry no language", () => {
    expect(spokenLanguageFromEnv({ LANG: "C.UTF-8" }, "C")).toBeUndefined();
    expect(spokenLanguageFromEnv({ LC_ALL: "POSIX" }, "en")).toBeUndefined();
  });
});

describe("pcmToWav", () => {
  test("wraps PCM in a 16 kHz mono header and drops a trailing odd byte", () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4, 5]));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });
});
