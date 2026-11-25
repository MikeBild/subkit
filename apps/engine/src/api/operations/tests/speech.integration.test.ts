import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { setSpeechServiceForTests } from "../../../speech/index.ts";
import { SpeechError, type Transcriber } from "../../../speech/port.ts";
import { createSpeechService } from "../../../speech/service.ts";

let ctx: HttpTestServer;
const seen: { contentType: string; language: string | undefined; bytes: number }[] = [];

const fake = (id: Transcriber["id"], text: string | Error): Transcriber => ({
  id,
  transcribe: async (request) => {
    seen.push({
      contentType: request.contentType,
      language: request.language,
      bytes: request.audio.byteLength,
    });
    if (text instanceof Error) throw text;
    return text;
  },
});

function useFakeSpeech(text: string | Error, preference: "auto" | "off" = "auto") {
  setSpeechServiceForTests(
    createSpeechService({
      settings: () => ({ preference, model: undefined, primaryProvider: "openai" }),
      configured: (id) => id === "openai",
      transcribers: {
        openai: fake("openai", text),
        azure: fake("azure", ""),
        gemini: fake("gemini", ""),
        local: fake("local", new SpeechError("local_model_missing", "prepare first", "local")),
      },
      local: { state: async () => ({ kind: "missing" }), prepare: async () => ({ kind: "ready" }) },
      clock: () => 0,
    }),
  );
}

async function post(path: string, body: unknown, auth = true) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const recording = {
  content_type: "audio/wav",
  content_base64: Buffer.from("RIFF-bytes").toString("base64"),
};

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_speech");
}, 120_000);

afterAll(async () => {
  setSpeechServiceForTests(null);
  await ctx?.cleanup();
}, 60_000);

describe("speech routes", () => {
  test("status reports the transcriber order", async () => {
    useFakeSpeech("hello");
    const response = await fetch(`${ctx.baseUrl}/v1/speech`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      preference: "auto",
      transcribers: ["openai", "local"],
      local_model: { kind: "missing" },
      needs_prepare: false,
    });
  });

  test("transcribes a recording and passes the language hint", async () => {
    useFakeSpeech("  dictated   text ");
    seen.length = 0;
    const result = await post("/v1/speech/transcriptions", { ...recording, language: "de" });
    expect(result).toEqual({
      status: 200,
      body: { text: "dictated text", transcriber: "openai", duration_ms: 0 },
    });
    expect(seen).toEqual([{ contentType: "audio/wav", language: "de", bytes: 10 }]);
  });

  test("refuses unsupported audio before any transcriber runs", async () => {
    useFakeSpeech("never");
    seen.length = 0;
    const result = await post("/v1/speech/transcriptions", {
      ...recording,
      content_type: "video/mp4",
    });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ code: "unsupported_audio" });
    expect(seen).toEqual([]);
  });

  test("keeps the code of the last failure", async () => {
    useFakeSpeech(new Error("HTTP 401 key rejected"));
    const result = await post("/v1/speech/transcriptions", recording);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "local_model_missing" });
  });

  test("answers 409 when dictation is turned off", async () => {
    useFakeSpeech("never", "off");
    const result = await post("/v1/speech/transcriptions", recording);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "speech_off" });
  });

  test("requires credentials", async () => {
    useFakeSpeech("never");
    expect((await post("/v1/speech/transcriptions", recording, false)).status).toBe(401);
  });
});
