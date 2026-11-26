import { describe, expect, test } from "bun:test";
import { insertTranscript } from "./insert-transcript";
import {
  isDictationShortcut,
  microphoneError,
  type ShortcutEvent,
  spokenLanguage,
  transcriptionError,
} from "./mic-error";
import {
  DICTATION_MAX_MS,
  type DictationState,
  dictationReducer,
  formatElapsed,
  initialDictation,
  reachedLimit,
} from "./recorder-machine";
import { encodeWav, mixToMono, rmsLevel, toBase64 } from "./wav";

const RECORDING = "00000000-0000-4000-8000-000000000001";

const run = (events: Parameters<typeof dictationReducer>[1][]): DictationState =>
  events.reduce(dictationReducer, initialDictation);

describe("dictationReducer", () => {
  test("walks idle → requesting → recording → transcribing → idle", () => {
    expect(run([{ type: "start", requestId: RECORDING }])).toEqual({
      phase: "requesting",
      session: 1,
      requestId: RECORDING,
    });
    expect(
      run([
        { type: "start", requestId: RECORDING },
        { type: "granted", session: 1, now: 100 },
      ]),
    ).toMatchObject({
      phase: "recording",
      startedAt: 100,
    });
    const done = run([
      { type: "start", requestId: RECORDING },
      { type: "granted", session: 1, now: 100 },
      { type: "tick", session: 1, now: 1600, level: 2 },
      { type: "stop", session: 1 },
      { type: "transcribed", session: 1 },
    ]);
    expect(done).toEqual({ phase: "idle", session: 1, error: null });
  });

  test("tick tracks elapsed time and clamps the level", () => {
    expect(
      run([
        { type: "start", requestId: RECORDING },
        { type: "granted", session: 1, now: 100 },
        { type: "tick", session: 1, now: 1600, level: 2 },
      ]),
    ).toMatchObject({ elapsedMs: 1500, level: 1 });
  });

  test("ignores events from an earlier session", () => {
    const state = run([
      { type: "start", requestId: RECORDING },
      { type: "cancel" },
      { type: "start", requestId: RECORDING },
      { type: "granted", session: 1, now: 5 },
    ]);
    expect(state).toEqual({ phase: "requesting", session: 2, requestId: RECORDING });
  });

  test("a denied microphone returns to idle with the reason", () => {
    expect(
      run([
        { type: "start", requestId: RECORDING },
        { type: "denied", session: 1, error: "permission_denied" },
      ]),
    ).toEqual({ phase: "idle", session: 1, error: "permission_denied" });
  });

  test("one recording keeps its request id until it is transcribed", () => {
    expect(
      run([
        { type: "start", requestId: RECORDING },
        { type: "granted", session: 1, now: 0 },
        { type: "stop", session: 1 },
      ]),
    ).toEqual({ phase: "transcribing", session: 1, requestId: RECORDING });
  });

  test("a second start while busy changes nothing", () => {
    const recording = run([
      { type: "start", requestId: RECORDING },
      { type: "granted", session: 1, now: 0 },
    ]);
    expect(dictationReducer(recording, { type: "start", requestId: RECORDING })).toBe(recording);
  });

  test("dismiss clears an error only when idle", () => {
    const failed = run([
      { type: "start", requestId: RECORDING },
      { type: "denied", session: 1, error: "no_microphone" },
    ]);
    expect(dictationReducer(failed, { type: "dismiss" })).toEqual({
      phase: "idle",
      session: 1,
      error: null,
    });
  });

  test("reachedLimit fires at the five minute cap", () => {
    const at = (now: number) =>
      run([
        { type: "start", requestId: RECORDING },
        { type: "granted", session: 1, now: 0 },
        { type: "tick", session: 1, now, level: 0 },
      ]);
    expect(reachedLimit(at(DICTATION_MAX_MS - 1))).toBe(false);
    expect(reachedLimit(at(DICTATION_MAX_MS))).toBe(true);
  });

  test("formatElapsed shows minutes and padded seconds", () => {
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
  });
});

describe("insertTranscript", () => {
  test("appends with one separating space", () => {
    expect(insertTranscript("Send this", null, " to Ana ")).toEqual({
      value: "Send this to Ana",
      caret: 16,
    });
  });

  test("replaces a selection and keeps the text after it", () => {
    expect(insertTranscript("Hello NAME, thanks", { start: 6, end: 10 }, "Ana")).toEqual({
      value: "Hello Ana, thanks",
      caret: 9,
    });
  });

  test("inserts into empty text without spaces", () => {
    expect(insertTranscript("", { start: 0, end: 0 }, "hi")).toEqual({ value: "hi", caret: 2 });
  });

  test("adds a space before following words", () => {
    expect(insertTranscript("one three", { start: 4, end: 4 }, "two")).toEqual({
      value: "one two three",
      caret: 8,
    });
  });

  test("an empty transcript leaves the text unchanged", () => {
    expect(insertTranscript("keep", { start: 2, end: 2 }, "  ")).toEqual({
      value: "keep",
      caret: 2,
    });
  });
});

describe("errors and shortcuts", () => {
  test("maps browser media errors to dictation errors", () => {
    expect(microphoneError({ name: "NotAllowedError" })).toBe("permission_denied");
    expect(microphoneError({ name: "NotFoundError" })).toBe("no_microphone");
    expect(microphoneError({ name: "NotReadableError" })).toBe("microphone_busy");
    expect(microphoneError(new Error("x"))).toBe("failed");
  });

  test("maps engine codes to dictation errors", () => {
    expect(transcriptionError("no_speech")).toBe("no_speech");
    expect(transcriptionError("local_model_missing")).toBe("preparing");
    expect(transcriptionError("speech_off")).toBe("speech_unavailable");
    expect(transcriptionError(undefined)).toBe("failed");
  });

  const key = (overrides: Partial<ShortcutEvent>): ShortcutEvent => ({
    key: "d",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  });

  test("Cmd+D on macOS and Ctrl+D elsewhere toggle dictation", () => {
    expect(isDictationShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isDictationShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isDictationShortcut(key({ ctrlKey: true }), false)).toBe(true);
  });

  test("ignores repeats, IME composition and extra modifiers", () => {
    expect(isDictationShortcut(key({ metaKey: true, repeat: true }), true)).toBe(false);
    expect(isDictationShortcut(key({ metaKey: true, isComposing: true }), true)).toBe(false);
    expect(isDictationShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
  });

  test("spokenLanguage takes the two letter code of the locale", () => {
    expect(spokenLanguage("de-DE")).toBe("de");
    expect(spokenLanguage("en")).toBe("en");
    expect(spokenLanguage("")).toBeUndefined();
  });
});

describe("wav", () => {
  test("encodes a 16-bit mono PCM header and clamps samples", () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });

  test("mixes channels to mono by averaging", () => {
    expect([...mixToMono([new Float32Array([1, 0]), new Float32Array([0, 0])])]).toEqual([0.5, 0]);
  });

  test("rmsLevel is zero for silence and capped at one", () => {
    expect(rmsLevel(new Float32Array(10))).toBe(0);
    expect(rmsLevel(new Float32Array([1, -1]))).toBe(1);
  });

  test("toBase64 round-trips bytes", () => {
    expect(atob(toBase64(new Uint8Array([104, 105])))).toBe("hi");
  });
});
