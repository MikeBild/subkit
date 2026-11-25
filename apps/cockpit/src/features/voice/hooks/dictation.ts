import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError } from "@/api/transport";
import { transcribeRecording } from "../api/speech";
import { microphoneError, transcriptionError } from "../model/mic-error";
import {
  type DictationError,
  dictationReducer,
  initialDictation,
  isBusy,
  reachedLimit,
} from "../model/recorder-machine";
import { DICTATION_SAMPLE_RATE, encodeWav, mixToMono, rmsLevel, toBase64 } from "../model/wav";

const TICK_MS = 100;

interface Capture {
  readonly session: number;
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly chunks: Blob[];
  readonly timer: ReturnType<typeof setInterval>;
}

export interface DictationOptions {
  readonly language: string | undefined;
  readonly deviceId?: string | undefined;
  readonly onTranscript: (text: string) => void;
}

const pickMimeType = (): string | undefined =>
  ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find(
    (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
  );

export const dictationSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  typeof MediaRecorder !== "undefined" &&
  typeof OfflineAudioContext !== "undefined";

async function toWav(blob: Blob): Promise<Uint8Array> {
  const decoder = new AudioContext();
  try {
    const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, DICTATION_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(mixToMono([rendered.getChannelData(0)]), DICTATION_SAMPLE_RATE);
  } finally {
    void decoder.close();
  }
}

function release(capture: Capture | null): void {
  if (!capture) return;
  clearInterval(capture.timer);
  for (const track of capture.stream.getTracks()) track.stop();
  void capture.context.close();
}

export function useDictation({ language, deviceId, onTranscript }: DictationOptions) {
  const [state, dispatch] = useReducer(dictationReducer, initialDictation);
  const capture = useRef<Capture | null>(null);
  const abort = useRef<AbortController | null>(null);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  const finish = useCallback(
    async (session: number, chunks: readonly Blob[], mimeType: string) => {
      const controller = new AbortController();
      abort.current = controller;
      try {
        const wav = await toWav(new Blob([...chunks], { type: mimeType }));
        const result = await transcribeRecording(toBase64(wav), language, controller.signal);
        if (controller.signal.aborted) return;
        transcriptRef.current(result.text);
        dispatch({ type: "transcribed", session });
      } catch (error) {
        if (controller.signal.aborted) return;
        const code: DictationError =
          error instanceof ApiError ? transcriptionError(error.code ?? undefined) : "failed";
        dispatch({ type: "failed", session, error: code });
      }
    },
    [language],
  );

  const stop = useCallback(() => {
    const current = capture.current;
    if (!current) return;
    capture.current = null;
    clearInterval(current.timer);
    dispatch({ type: "stop", session: current.session });
    const mimeType = current.recorder.mimeType || "audio/webm";
    current.recorder.onstop = () => {
      release(current);
      void finish(current.session, current.chunks, mimeType);
    };
    current.recorder.stop();
  }, [finish]);

  const start = useCallback(async () => {
    if (isBusy(state) || !dictationSupported()) return;
    const session = state.session + 1;
    dispatch({ type: "start" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
    } catch (error) {
      dispatch({ type: "denied", session, error: microphoneError(error) });
      return;
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      dispatch({ type: "tick", session, now: Date.now(), level: rmsLevel(samples) });
    }, TICK_MS);
    capture.current = { session, stream, recorder, context, analyser, chunks, timer };
    recorder.start(250);
    dispatch({ type: "granted", session, now: Date.now() });
  }, [deviceId, state]);

  const cancel = useCallback(() => {
    const current = capture.current;
    capture.current = null;
    if (current) {
      current.recorder.onstop = null;
      if (current.recorder.state !== "inactive") current.recorder.stop();
      release(current);
    }
    abort.current?.abort();
    dispatch({ type: "cancel" });
  }, []);

  const toggle = useCallback(() => {
    if (state.phase === "recording") stop();
    else if (state.phase === "idle") void start();
  }, [start, state.phase, stop]);

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  useEffect(() => {
    if (reachedLimit(state)) stop();
  }, [state, stop]);

  useEffect(
    () => () => {
      release(capture.current);
      capture.current = null;
      abort.current?.abort();
    },
    [],
  );

  return { state, start, stop, toggle, cancel, dismiss } as const;
}

export type Dictation = ReturnType<typeof useDictation>;
