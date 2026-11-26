import { describe, expect, test } from "bun:test";
import type { Executor } from "../db/index.ts";
import {
  priorAttempt,
  reservationTransition,
  type TranscriptionReservationState,
} from "../llm/core/transcription-reservation.ts";
import type { LocalModelState } from "./core/model-files.ts";
import type { CloudTranscriberId, TranscriberId } from "./core/order.ts";
import {
  SpeechError,
  type Transcriber,
  type TranscriberOutput,
  type TranscriptionKeyOwner,
  type TranscriptionLedger,
} from "./port.ts";
import { createSpeechService, parsePreference, type SpeechServiceDeps } from "./service.ts";

const fixed = (
  id: TranscriberId,
  result: string | Error,
  extra: Omit<TranscriberOutput, "text"> = {},
): Transcriber => ({
  id,
  transcribe: async () => {
    if (result instanceof Error) throw result;
    return { text: result, ...extra };
  },
});

interface LedgerRow {
  state: TranscriptionReservationState;
  transcriber: CloudTranscriberId;
  seconds: number;
  transcript: string | null;
}

function memoryLedger(fits: () => boolean = () => true) {
  const rows = new Map<string, LedgerRow>();
  const steps: string[] = [];
  const move = (id: string, event: "settle" | "release", patch: Partial<LedgerRow>) => {
    const row = rows.get(id);
    const next = reservationTransition(row?.state ?? null, event);
    if (!row || !next) return false;
    rows.set(id, { ...row, ...patch, state: next });
    steps.push(`${event}:${row.transcriber}`);
    return true;
  };
  const prior = (id: string) => {
    const row = rows.get(id);
    const kind = priorAttempt(row?.state ?? null, row?.transcript != null);
    return kind === "replay" && row?.transcript != null
      ? { kind, text: row.transcript, transcriber: row.transcriber, latency_ms: 0 }
      : { kind: kind === "replay" ? ("unsettled" as const) : kind };
  };
  const ledger: TranscriptionLedger = {
    prior: async (key) => prior(key.clientRequestId),
    reserve: async (input) => {
      const current = prior(input.clientRequestId);
      if (current.kind !== "fresh") return current;
      if (!fits()) return { kind: "spend_limit" };
      rows.set(input.clientRequestId, {
        state: "reserved",
        transcriber: input.transcriber,
        seconds: input.estimateSeconds,
        transcript: null,
      });
      steps.push(`reserve:${input.transcriber}:${input.estimateSeconds}`);
      return { kind: "reserved" };
    },
    settle: async (input) =>
      move(input.clientRequestId, "settle", {
        seconds: input.audioSeconds,
        transcript: input.transcript,
      }),
    release: async (input) => move(input.clientRequestId, "release", { seconds: 0 }),
  };
  return { ledger, rows, steps };
}

function service(
  overrides: Partial<SpeechServiceDeps> & {
    localState?: LocalModelState;
    owner?: TranscriptionKeyOwner;
  } = {},
) {
  const calls: string[] = [];
  const memory = memoryLedger();
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
    keyOwner: async (id) => (id === "openai" ? (overrides.owner ?? "operator") : null),
    spendAllows: async () => true,
    ledger: memory.ledger,
    local: {
      state: async () => overrides.localState ?? { kind: "missing" },
      prepare: async () => ({ kind: "ready" }),
    },
    clock: () => 0,
    ...overrides,
    transcribers: {
      openai: record(transcribers.openai),
      azure: record(transcribers.azure),
      gemini: record(transcribers.gemini),
      local: record(transcribers.local),
    },
  };
  return { speech: createSpeechService(deps), calls, ...memory };
}

const request = {
  tenantId: "t1",
  db: {} as Executor,
  clientRequestId: "rec-1",
  audio: new Uint8Array([1]),
  contentType: "audio/wav",
};

function silentWav(samples: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, index) => {
      view.setUint8(offset + index, char.charCodeAt(0));
    });
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

const withOpenai = (result: string | Error, extra: Omit<TranscriberOutput, "text"> = {}) => ({
  openai: fixed("openai", result, extra),
  azure: fixed("azure", ""),
  gemini: fixed("gemini", ""),
  local: fixed("local", "from local"),
});

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
    const { speech, calls } = service({ transcribers: withOpenai(new Error("HTTP 429")) });
    expect((await speech.transcribe(request)).transcriber).toBe("local");
    expect(calls).toEqual(["openai", "local"]);
  });

  test("reports no speech without trying further transcribers", async () => {
    const { speech, calls } = service({ transcribers: withOpenai("  ") });
    await expect(speech.transcribe(request)).rejects.toMatchObject({
      code: "no_speech",
      status: 422,
    });
    expect(calls).toEqual(["openai"]);
  });

  test("keeps the cause of the last failure", async () => {
    const { speech } = service({
      transcribers: {
        ...withOpenai(new Error("HTTP 401 key rejected")),
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
    const onlyLocal = service({ keyOwner: async () => null });
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

describe("operator key reservation", () => {
  test("reserves the measured length and settles the time the provider reports", async () => {
    const { speech, steps, rows } = service({
      transcribers: withOpenai("booked", { model: "gpt-4o-mini-transcribe", audio_seconds: 1.5 }),
    });
    await speech.transcribe({ ...request, audio: silentWav(32_000) });
    expect(steps).toEqual(["reserve:openai:2", "settle:openai"]);
    expect(rows.get("rec-1")).toEqual({
      state: "settled",
      transcriber: "openai",
      seconds: 1.5,
      transcript: "booked",
    });
  });

  test("reserves the dictation cap when the length is unknown and keeps it at settlement", async () => {
    const { speech, rows } = service();
    await speech.transcribe(request);
    expect(rows.get("rec-1")).toMatchObject({ state: "settled", seconds: 300 });
  });

  test("a provider failure releases the reservation before the local fallback", async () => {
    const { speech, steps, rows } = service({ transcribers: withOpenai(new Error("HTTP 500")) });
    expect((await speech.transcribe(request)).transcriber).toBe("local");
    expect(steps).toEqual(["reserve:openai:300", "release:openai"]);
    expect(rows.get("rec-1")).toMatchObject({ state: "released", seconds: 0 });
  });

  test("an empty result is still settled because the provider charged it", async () => {
    const { speech, steps } = service({ transcribers: withOpenai("  ") });
    await expect(speech.transcribe(request)).rejects.toMatchObject({ code: "no_speech" });
    expect(steps).toEqual(["reserve:openai:300", "settle:openai"]);
  });

  test("a retry after success replays the transcript without calling the provider", async () => {
    const { speech, calls, steps } = service();
    const first = await speech.transcribe(request);
    expect(await speech.transcribe(request)).toEqual(first);
    expect(calls).toEqual(["openai"]);
    expect(steps).toEqual(["reserve:openai:300", "settle:openai"]);
  });

  test("a retry while the first attempt runs is refused as in progress", async () => {
    let finish: (value: TranscriberOutput) => void = () => {};
    const pending = new Promise<TranscriberOutput>((resolve) => {
      finish = resolve;
    });
    const { speech, calls } = service({
      transcribers: {
        ...withOpenai(""),
        openai: { id: "openai", transcribe: () => pending },
      },
    });
    const first = speech.transcribe(request);
    await expect(speech.transcribe(request)).rejects.toMatchObject({
      code: "transcription_in_progress",
      status: 409,
    });
    finish({ text: "done" });
    expect((await first).text).toBe("done");
    expect(calls).toEqual(["openai"]);
  });

  test("a retry after a lapsed reservation is refused as unsettled", async () => {
    const { speech, rows, calls } = service();
    rows.set("rec-1", {
      state: "reconciliation_required",
      transcriber: "openai",
      seconds: 300,
      transcript: null,
    });
    await expect(speech.transcribe(request)).rejects.toMatchObject({
      code: "transcription_unsettled",
      status: 409,
    });
    expect(calls).toEqual([]);
  });

  test("a retry after a released attempt reserves again", async () => {
    const { speech, rows, steps } = service();
    rows.set("rec-1", { state: "released", transcriber: "openai", seconds: 0, transcript: null });
    await speech.transcribe(request);
    expect(steps).toEqual(["reserve:openai:300", "settle:openai"]);
  });

  test("a reservation over the spend limit skips the cloud for the local model", async () => {
    const memory = memoryLedger(() => false);
    const { speech, calls } = service({ ledger: memory.ledger });
    expect((await speech.transcribe(request)).transcriber).toBe("local");
    expect(calls).toEqual(["local"]);
    expect(memory.rows.size).toBe(0);
  });

  test("a reached spend limit removes the operator key from the order", async () => {
    const { speech, calls, steps } = service({ spendAllows: async () => false });
    expect(await speech.transcribe(request)).toMatchObject({ transcriber: "local" });
    expect(calls).toEqual(["local"]);
    expect(steps).toEqual([]);
    expect((await speech.status("t1")).transcribers).toEqual(["local"]);
  });

  test("an explicit cloud choice also falls back to the local model at the spend limit", async () => {
    const { speech, calls } = service({
      settings: () => ({ preference: "openai", model: undefined, primaryProvider: "openai" }),
      spendAllows: async () => false,
    });
    expect((await speech.transcribe(request)).transcriber).toBe("local");
    expect(calls).toEqual(["local"]);
  });

  test("a workspace key and the local model are never reserved nor gated by the spend limit", async () => {
    let asked = 0;
    const { speech, steps, calls } = service({
      owner: "workspace",
      spendAllows: async () => {
        asked += 1;
        return false;
      },
      transcribers: withOpenai(new Error("HTTP 500")),
    });
    expect((await speech.transcribe(request)).transcriber).toBe("local");
    expect(calls).toEqual(["openai", "local"]);
    expect(steps).toEqual([]);
    expect(asked).toBe(0);
  });

  test("a failing ledger write leaves the reservation to the sweep and still answers", async () => {
    const memory = memoryLedger();
    const { speech } = service({
      ledger: {
        ...memory.ledger,
        settle: async () => {
          throw new Error("connection reset");
        },
      },
    });
    expect((await speech.transcribe(request)).text).toBe("hello world");
    expect(memory.rows.get("rec-1")?.state).toBe("reserved");
  });
});
