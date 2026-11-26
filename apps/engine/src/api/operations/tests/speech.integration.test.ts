import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { llmUsage } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { setSpeechServiceForTests } from "../../../speech/index.ts";
import { SpeechError, type Transcriber } from "../../../speech/port.ts";
import { transcriptionLedger } from "../../../speech/providers/ledger.ts";
import { createSpeechService } from "../../../speech/service.ts";

let ctx: HttpTestServer;
const seen: {
  contentType: string;
  language: string | undefined;
  bytes: number;
  clientRequestId: string;
}[] = [];

const fake = (id: Transcriber["id"], text: string | Error): Transcriber => ({
  id,
  transcribe: async (request) => {
    seen.push({
      contentType: request.contentType,
      language: request.language,
      bytes: request.audio.byteLength,
      clientRequestId: request.clientRequestId,
    });
    if (text instanceof Error) throw text;
    return { text };
  },
});

function useFakeSpeech(text: string | Error, preference: "auto" | "off" = "auto") {
  setSpeechServiceForTests(
    createSpeechService({
      settings: () => ({ preference, model: undefined, primaryProvider: "openai" }),
      keyOwner: async (id) => (id === "openai" ? "operator" : null),
      spendAllows: async () => true,
      ledger: transcriptionLedger,
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
    expect(seen).toMatchObject([{ contentType: "audio/wav", language: "de", bytes: 10 }]);
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

  test("a retry of one recording calls the provider once and books one row", async () => {
    useFakeSpeech("  booked once ");
    seen.length = 0;
    const client_request_id = "00000000-0000-4000-8000-000000000914";
    const first = await post("/v1/speech/transcriptions", { ...recording, client_request_id });
    const retry = await post("/v1/speech/transcriptions", { ...recording, client_request_id });
    expect(first).toEqual({
      status: 200,
      body: { text: "booked once", transcriber: "openai", duration_ms: 0 },
    });
    expect(retry).toEqual(first);
    expect(seen.map((call) => call.clientRequestId)).toEqual([client_request_id]);
    const rows = await ctx.db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.client_request_id, client_request_id));
    expect(rows).toMatchObject([
      {
        tenant_id: ctx.tenantId,
        flow: "transcription",
        reservation: "settled",
        audio_seconds: 300,
      },
    ]);
  });

  test("a failed provider call retains its reservation for reconciliation", async () => {
    useFakeSpeech(new Error("HTTP 500"));
    const client_request_id = "00000000-0000-4000-8000-000000000915";
    const result = await post("/v1/speech/transcriptions", { ...recording, client_request_id });
    expect(result.status).toBe(409);
    const rows = await ctx.db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.client_request_id, client_request_id));
    expect(rows).toMatchObject([
      { reservation: "reconciliation_required", audio_seconds: 300, result: "error" },
    ]);
  });

  test("refuses a request id that is not a uuid", async () => {
    useFakeSpeech("never");
    const result = await post("/v1/speech/transcriptions", {
      ...recording,
      client_request_id: "recording-1",
    });
    expect(result.status).toBe(400);
  });

  test("requires credentials", async () => {
    useFakeSpeech("never");
    expect((await post("/v1/speech/transcriptions", recording, false)).status).toBe(401);
  });
});
