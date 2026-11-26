import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { llmUsage } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { TranscriptionDispatchError } from "../../../llm/core/transcription-failure.ts";
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

  const usageOf = (client_request_id: string) =>
    ctx.db.select().from(llmUsage).where(eq(llmUsage.client_request_id, client_request_id));

  test("a definite provider rejection releases its reservation and frees the budget", async () => {
    useFakeSpeech(
      new TranscriptionDispatchError(new Error("invalid api key"), [
        { phase: "answered", status: 401 },
      ]),
    );
    const client_request_id = "00000000-0000-4000-8000-000000000916";
    const result = await post("/v1/speech/transcriptions", { ...recording, client_request_id });
    expect(result.status).toBe(409);
    expect(await usageOf(client_request_id)).toMatchObject([
      { reservation: "released", audio_seconds: 0, result: "error" },
    ]);
  });

  test("an ambiguous provider failure stays charged and its retry is refused", async () => {
    useFakeSpeech(
      new TranscriptionDispatchError(new Error("request timed out"), [{ phase: "sent" }]),
    );
    const client_request_id = "00000000-0000-4000-8000-000000000915";
    const result = await post("/v1/speech/transcriptions", { ...recording, client_request_id });
    expect(result.status).toBe(409);
    expect(await usageOf(client_request_id)).toMatchObject([
      { reservation: "reconciliation_required", audio_seconds: 300, result: "error" },
    ]);
    const calls = seen.length;
    const retry = await post("/v1/speech/transcriptions", { ...recording, client_request_id });
    expect(retry).toMatchObject({ status: 409, body: { code: "transcription_unsettled" } });
    expect(seen).toHaveLength(calls);
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

describe("transcription ledger adapter", () => {
  const key = (clientRequestId: string) => ({
    tenantId: ctx.tenantId,
    clientRequestId,
    db: ctx.db,
  });
  const reservation = (clientRequestId: string) => ({
    ...key(clientRequestId),
    transcriber: "openai" as const,
    model: undefined,
    estimateSeconds: 10,
    actor: undefined,
  });

  test("a second reservation of an open request is answered as in progress", async () => {
    const id = "00000000-0000-4000-8000-000000000917";
    expect(await transcriptionLedger.reserve(reservation(id))).toEqual({ kind: "reserved" });
    expect(await transcriptionLedger.reserve(reservation(id))).toEqual({ kind: "in_progress" });
    expect(await transcriptionLedger.release({ ...key(id), latencyMs: 5 })).toBe(true);
    expect(await transcriptionLedger.reserve(reservation(id))).toEqual({ kind: "reserved" });
    expect(await transcriptionLedger.reconcile({ ...key(id), latencyMs: 5 })).toBe(true);
    expect(await transcriptionLedger.prior(key(id))).toEqual({ kind: "unsettled" });
  });

  test("a settled transcript of an unknown transcriber is never replayed", async () => {
    const id = "00000000-0000-4000-8000-000000000918";
    await transcriptionLedger.reserve(reservation(id));
    await ctx.db
      .update(llmUsage)
      .set({
        reservation: "settled",
        lease_until: null,
        model: "elsewhere/model",
        transcript: "stored",
      })
      .where(eq(llmUsage.client_request_id, id));
    expect(await transcriptionLedger.prior(key(id))).toEqual({ kind: "unsettled" });
  });
});
