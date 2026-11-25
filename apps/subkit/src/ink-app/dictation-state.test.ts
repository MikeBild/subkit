import { describe, expect, test } from "bun:test";
import { EngineError } from "@cli-core/errors.ts";
import { dictationCheck } from "../commands/doctor-checks.ts";
import {
  dictationFailure,
  dictationInsertText,
  dictationStatusLine,
  IDLE,
} from "./dictation-state.ts";

describe("dictationInsertText", () => {
  test("adds a leading space after a word and a trailing space before one", () => {
    expect(dictationInsertText("send", 4, " to Ana ")).toBe(" to Ana");
    expect(dictationInsertText("one three", 4, "two")).toBe("two ");
    expect(dictationInsertText("", 0, "hello")).toBe("hello");
  });

  test("keeps punctuation attached and ignores empty transcripts", () => {
    expect(dictationInsertText("Hi.", 2, "there")).toBe(" there");
    expect(dictationInsertText("text", 4, "   ")).toBe("");
  });
});

describe("dictationStatusLine", () => {
  test("shows the recording clock and the keys", () => {
    expect(dictationStatusLine({ kind: "recording", startedAt: 1_000, tool: "rec" }, 66_500)).toBe(
      "● REC 1:05 · Ctrl+D insert · Esc discard",
    );
  });

  test("names the transcription and stays empty when idle", () => {
    expect(dictationStatusLine({ kind: "transcribing" }, 0)).toContain("writing down");
    expect(dictationStatusLine(IDLE, 0)).toBeNull();
  });
});

describe("dictationFailure", () => {
  test("explains engine refusals by their code", () => {
    expect(dictationFailure(new EngineError(422, { code: "no_speech", message: "x" }))).toContain(
      "nothing was heard",
    );
    expect(
      dictationFailure(new EngineError(409, { code: "local_model_missing", message: "x" })),
    ).toContain("still loading");
    expect(dictationFailure(new EngineError(409, { code: "speech_off", message: "x" }))).toContain(
      "not available",
    );
  });

  test("keeps the cause of other failures", () => {
    expect(dictationFailure(new Error("rec recorded no audio"))).toBe(
      "dictation failed: rec recorded no audio",
    );
  });
});

describe("dictationCheck", () => {
  test("reports the recorder or how to install one", () => {
    expect(dictationCheck("ffmpeg", "hint")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("ffmpeg"),
    });
    expect(dictationCheck(null, "brew install sox")).toMatchObject({
      status: "warn",
      hint: "brew install sox",
    });
  });
});
