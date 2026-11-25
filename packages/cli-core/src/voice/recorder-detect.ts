export const VOICE_SAMPLE_RATE = 16_000;

export type RecorderTool = "rec" | "sox" | "ffmpeg" | "arecord";

export interface RecorderCommand {
  readonly tool: RecorderTool;
  readonly command: string;
  readonly args: readonly string[];
  readonly stop: "stdin-q" | "kill";
}

export interface RecorderEnvironment {
  readonly platform: NodeJS.Platform;
  readonly which: (tool: RecorderTool) => string | null;
  readonly device?: string | undefined;
}

const RAW_OUT = [
  "-t",
  "raw",
  "-e",
  "signed-integer",
  "-b",
  "16",
  "-c",
  "1",
  "-r",
  String(VOICE_SAMPLE_RATE),
  "-",
];

function ffmpegInput(
  platform: NodeJS.Platform,
  device: string | undefined,
): readonly string[] | null {
  if (platform === "darwin") return ["-f", "avfoundation", "-i", `:${device ?? "default"}`];
  if (platform === "linux") return ["-f", "pulse", "-i", device ?? "default"];
  if (platform === "win32") return device ? ["-f", "dshow", "-i", `audio=${device}`] : null;
  return null;
}

const ffmpegArgs = (input: readonly string[]): readonly string[] => [
  "-hide_banner",
  "-loglevel",
  "error",
  ...input,
  "-ac",
  "1",
  "-ar",
  String(VOICE_SAMPLE_RATE),
  "-f",
  "s16le",
  "-",
];

export function recorderCommand(env: RecorderEnvironment): RecorderCommand | null {
  const rec = env.which("rec");
  if (rec) return { tool: "rec", command: rec, args: ["-q", ...RAW_OUT], stop: "kill" };
  const sox = env.which("sox");
  if (sox) {
    const input = env.platform === "win32" ? ["-t", "waveaudio", env.device ?? "default"] : ["-d"];
    return { tool: "sox", command: sox, args: ["-q", ...input, ...RAW_OUT], stop: "kill" };
  }
  const ffmpeg = env.which("ffmpeg");
  const input = ffmpeg ? ffmpegInput(env.platform, env.device) : null;
  if (ffmpeg && input)
    return { tool: "ffmpeg", command: ffmpeg, args: ffmpegArgs(input), stop: "stdin-q" };
  const arecord = env.platform === "linux" ? env.which("arecord") : null;
  if (arecord)
    return {
      tool: "arecord",
      command: arecord,
      args: [
        "-q",
        "-f",
        "S16_LE",
        "-c",
        "1",
        "-r",
        String(VOICE_SAMPLE_RATE),
        "-t",
        "raw",
        ...(env.device ? ["-D", env.device] : []),
      ],
      stop: "kill",
    };
  return null;
}

export function parseDshowAudioDevices(stderr: string): readonly string[] {
  return [...stderr.matchAll(/"([^"]+)"\s*\(audio\)/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

export function recorderInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "install a recorder with `brew install sox` (or ffmpeg)";
  if (platform === "win32") return "install a recorder with `winget install Gyan.FFmpeg` (or SoX)";
  return "install a recorder, e.g. `sudo apt install sox` or `alsa-utils` for arecord";
}

export function spokenLanguageFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fallbackLocale: string,
): string | undefined {
  const raw =
    env.SUBKIT_DICTATION_LANGUAGE || env.LC_ALL || env.LC_MESSAGES || env.LANG || fallbackLocale;
  const code = raw.match(/^([a-z]{2})(?:[-_.]|$)/i)?.[1]?.toLowerCase();
  return code;
}

export function pcmToWav(pcm: Uint8Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const length = pcm.byteLength - (pcm.byteLength % 2);
  const wav = new Uint8Array(44 + length);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length, true);
  wav.set(pcm.subarray(0, length), 44);
  return wav;
}
