import { detectRecorder, type Recording, startRecording } from "@cli-core/voice/recorder.ts";
import { recorderInstallHint, spokenLanguageFromEnv } from "@cli-core/voice/recorder-detect.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient } from "../engine-client.ts";
import {
  type DictationPhase,
  dictationFailure,
  dictationStatusLine,
  IDLE,
} from "./dictation-state.ts";

interface DictationDeps {
  readonly engineClient: EngineClient | undefined;
  readonly insertText: (transcript: string) => void;
  readonly showInfo: (message: string) => void;
  readonly showError: (message: string) => void;
}

interface TranscriptionResponse {
  readonly text: string;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export function useDictation({ engineClient, insertText, showInfo, showError }: DictationDeps) {
  const [phase, setPhase] = useState<DictationPhase>(IDLE);
  const [now, setNow] = useState(() => Date.now());
  const recording = useRef<Recording | null>(null);

  const stop = useCallback(async () => {
    const current = recording.current;
    if (!current || !engineClient) return;
    recording.current = null;
    setPhase({ kind: "transcribing" });
    try {
      const wav = await current.stop();
      const language = spokenLanguageFromEnv(
        process.env,
        Intl.DateTimeFormat().resolvedOptions().locale,
      );
      const result = await engineClient.request<TranscriptionResponse>(
        "POST",
        "/v1/speech/transcriptions",
        {
          content_type: "audio/wav",
          content_base64: toBase64(wav),
          ...(language ? { language } : {}),
        },
      );
      insertText(result.text);
    } catch (error) {
      showError(dictationFailure(error));
    } finally {
      setPhase(IDLE);
    }
  }, [engineClient, insertText, showError]);

  const start = useCallback(() => {
    if (recording.current || !engineClient) return;
    const recorder = detectRecorder();
    if (!recorder) {
      showError(`dictation needs a recorder: ${recorderInstallHint(process.platform)}`);
      return;
    }
    try {
      recording.current = startRecording(recorder, { onLimit: () => void stop() });
    } catch (error) {
      showError(dictationFailure(error));
      return;
    }
    setNow(Date.now());
    setPhase({ kind: "recording", startedAt: Date.now(), tool: recorder.tool });
  }, [engineClient, showError, stop]);

  const toggle = useCallback(() => {
    if (phase.kind === "recording") void stop();
    else if (phase.kind === "idle") start();
  }, [phase.kind, start, stop]);

  const cancel = useCallback(() => {
    recording.current?.cancel();
    recording.current = null;
    setPhase(IDLE);
    showInfo("dictation discarded");
  }, [showInfo]);

  useEffect(() => {
    if (phase.kind !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase.kind]);

  useEffect(() => () => recording.current?.cancel(), []);

  return {
    active: phase.kind !== "idle",
    recording: phase.kind === "recording",
    statusLine: dictationStatusLine(phase, now),
    toggle,
    cancel,
  } as const;
}

export type Dictation = ReturnType<typeof useDictation>;
