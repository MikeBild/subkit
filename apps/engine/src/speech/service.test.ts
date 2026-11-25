import { describe, expect, test } from "bun:test";
import type { LocalModelState } from "./core/model-files.ts";
import type { TranscriberId } from "./core/order.ts";
import { SpeechError, type Transcriber } from "./port.ts";
import { createSpeechService, parsePreference, type SpeechServiceDeps } from "./service.ts";

const fixed = (id: TranscriberId, result: string | Error): Transcriber => ({
  id,
  transcribe: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

function service(overrides: Partial<SpeechServiceDeps> & { localState?: LocalModelState } = {}) {
  const calls: string[] = [];
  const record = (transcriber: Transcriber): Transcriber => ({
    id: transcriber.id,
    transcribe: (request) => {
      calls.push(transcriber.id);
      return transcriber.transcribe(request);
    },
  });
  const transcribers = overrides.transcribers ?? {
    openai: fixed("openai", " hello  world "),
    azure: fixed("azure", "azure text"),
    gemini: fixed("gemini", "gemini text"),
    local: fixed("local", "local text"),
  };
  const deps: SpeechServiceDeps = {
    settings: () => ({ preference: "auto", model: undefined, primaryProvider: "anthropic" }),
    configured: (id) => id === "openai",
    local: {
      state: async () => overrides.localState ?? { kind: "missing" },
      prepare: async () => ({ kind: "ready" }),
    },
    clock: () => 1000,
    ...overrides,
    transcribers: {
      openai: record(transcribers.openai),
      azure: record(transcribers.azure),
      gemini: record(transcribers.gemini),
      local: record(transcribers.local),
    },
  };
  return { speech: createSpeechService(deps), calls };
}

const request = { tenantId: "t1", audio: new Uint8Array([1]), contentType: "audio/wav" };

describe("speech service", () => {
  test("uses the first configured transcriber and normalises its text", async () => {
    const { speech, calls } = service();
    expect(await speech.transcribe(request)).toEqual({
      text: "hello world",
      transcriber: "openai",
      duration_ms: 0,
    });
    expect(calls).toEqual(["openai"]);
  });

  test("falls back to the local model when the cloud call fails", async () => {
    const { speech, calls } = service({
      transcribers: {
        openai: fixed("openai", new Error("HTTP 429 rate limited")),
        azure: fixed("azure", ""),
        gemini: fixed("gemini", ""),
        local: fixed("local", "from local"),
      },
    });
    expect((await speech.transcribe(request)).transcriber).toBe("local");
    expect(calls).toEqual(["openai", "local"]);
  });

  test("reports no speech without trying further transcribers", async () => {
    const { speech, calls } = service({
      transcribers: {
        openai: fixed("openai", "  "),
        azure: fixed("azure", ""),
        gemini: fixed("gemini", ""),
        local: fixed("local", "never"),
      },
    });
    await expect(speech.transcribe(request)).rejects.toMatchObject({
      code: "no_speech",
      status: 422,
    });
    expect(calls).toEqual(["openai"]);
  });

  test("keeps the cause of the last failure", async () => {
    const { speech } = service({
      transcribers: {
        openai: fixed("openai", new Error("HTTP 401 key rejected")),
        azure: fixed("azure", ""),
        gemini: fixed("gemini", ""),
        local: fixed("local", new SpeechError("local_model_missing", "prepare first", "local")),
      },
    });
    await expect(speech.transcribe(request)).rejects.toMatchObject({ code: "local_model_missing" });
  });

  test("refuses when dictation is turned off", async () => {
    const { speech, calls } = service({
      settings: () => ({ preference: "off", model: undefined, primaryProvider: "openai" }),
    });
    await expect(speech.transcribe(request)).rejects.toMatchObject({
      code: "speech_off",
      status: 409,
    });
    expect(calls).toEqual([]);
  });

  test("status asks for preparation only when the local model is the only way", async () => {
    const onlyLocal = service({ configured: () => false });
    expect(await onlyLocal.speech.status("t1")).toMatchObject({
      available: true,
      transcribers: ["local"],
      needs_prepare: true,
    });
    const withCloud = service();
    expect((await withCloud.speech.status("t1")).needs_prepare).toBe(false);
  });

  test("parsePreference falls back to auto for unknown values", () => {
    expect(parsePreference("gemini")).toBe("gemini");
    expect(parsePreference("whisper")).toBe("auto");
    expect(parsePreference(undefined)).toBe("auto");
  });
});
