import { formatBytes } from "@shared/file-kinds.ts";
import { Button } from "@ui/atoms/button";
import { IconButton } from "@ui/molecules/icon-button";
import { RecordingIndicator } from "@ui/molecules/recording-indicator";
import { Mic, Square, X } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import { usePrepareSpeech, useSpeechStatus } from "../api/speech";
import { dictationSupported, useDictation } from "../hooks/dictation";
import { isDictationShortcut, spokenLanguage } from "../model/mic-error";
import { formatElapsed } from "../model/recorder-machine";

const LOCAL_MODEL_BYTES = 80_000_000;

const isMacPlatform = (): boolean =>
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

export function DictationControl({
  disabled,
  scopeRef,
  onTranscript,
}: {
  disabled: boolean;
  scopeRef: RefObject<HTMLElement | null>;
  onTranscript: (text: string) => void;
}) {
  const { t, locale } = useI18n();
  const [supported] = useState(dictationSupported);
  const status = useSpeechStatus(supported);
  const prepare = usePrepareSpeech();
  const dictation = useDictation({ language: spokenLanguage(locale), onTranscript });
  const { state, toggle, cancel, dismiss } = dictation;
  const mac = isMacPlatform();
  const shortcut = mac ? "⌘D" : "Ctrl+D";
  const usable = supported && status?.available === true && !status.needs_prepare;
  const downloading = status?.local_model.kind === "downloading";

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope || !usable || disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isDictationShortcut(event, mac)) return;
      if (document.querySelector("[role=dialog][data-state=open]")) return;
      event.preventDefault();
      toggle();
    };
    scope.addEventListener("keydown", onKey);
    return () => scope.removeEventListener("keydown", onKey);
  }, [disabled, mac, scopeRef, toggle, usable]);

  if (!supported || !status?.available) return null;

  if (status.needs_prepare)
    return downloading ? (
      <RecordingIndicator phase="working" label={t("voice.preparing")} />
    ) : (
      <IconButton
        label={t("voice.prepare")}
        tooltip={t("voice.prepare.hint", { size: formatBytes(LOCAL_MODEL_BYTES, locale) })}
        disabled={disabled}
        onClick={() => void prepare()}
        data-testid="chat-voice-prepare"
      >
        <Mic />
      </IconButton>
    );

  const recording = state.phase === "recording";
  const working = state.phase === "transcribing" || state.phase === "requesting";

  return (
    <span className="inline-flex items-center gap-1" data-testid="chat-voice">
      <IconButton
        label={recording ? t("voice.stop") : t("voice.start.shortcut", { shortcut })}
        aria-pressed={recording}
        variant={recording ? "destructive" : "ghost"}
        disabled={disabled || working}
        onClick={toggle}
        data-testid="chat-voice-toggle"
      >
        {recording ? <Square /> : <Mic />}
      </IconButton>
      {recording ? (
        <>
          <RecordingIndicator
            phase="recording"
            label={t("voice.listening")}
            elapsed={formatElapsed(state.elapsedMs)}
            level={state.level}
          />
          <IconButton label={t("voice.cancel")} onClick={cancel} data-testid="chat-voice-cancel">
            <X />
          </IconButton>
        </>
      ) : null}
      {state.phase === "transcribing" ? (
        <RecordingIndicator phase="working" label={t("voice.transcribing")} />
      ) : null}
      {state.phase === "idle" && state.error ? (
        <span
          role="alert"
          className="inline-flex items-center gap-1 text-xs text-destructive"
          data-testid="chat-voice-error"
        >
          {t(`voice.error.${state.error}`)}
          <Button variant="ghost" size="sm" onClick={dismiss} data-testid="chat-voice-dismiss">
            {t("voice.dismiss")}
          </Button>
        </span>
      ) : null}
    </span>
  );
}
