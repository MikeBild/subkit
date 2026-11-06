import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode } from "../repl/status-line/render.ts";

const YOLO_MAX_TURNS = 10;
const YOLO_MAX_DURATION_MS = 10 * 60 * 1000;

interface YoloApi {
  activeMode: PermissionMode;
  setActiveMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  awaitingYoloArm: boolean;
  noteTurnStart: () => void;
  consumeArmAnswer: (trimmed: string) => boolean;
  runYoloSlash: (trimmed: string, hasPendingElicitation: boolean) => void;
}

export function useYoloMode(
  initialMode: PermissionMode,
  showInfo: (message: string) => void,
  showError: (message: string) => void,
): YoloApi {
  const [activeMode, setActiveMode] = useState<PermissionMode>(initialMode);
  const preYoloModeRef = useRef<PermissionMode>(initialMode);
  const [awaitingYoloArm, setAwaitingYoloArm] = useState<boolean>(false);
  const yoloArmedAtRef = useRef<number | null>(null);
  const yoloTurnCountRef = useRef<number>(0);

  useEffect(() => {
    if (activeMode !== "yolo") return;
    const armedAt = yoloArmedAtRef.current ?? Date.now();
    const remaining = YOLO_MAX_DURATION_MS - (Date.now() - armedAt);
    const timer = setTimeout(
      () => {
        if (activeMode === "yolo") {
          const restored = preYoloModeRef.current;
          yoloArmedAtRef.current = null;
          yoloTurnCountRef.current = 0;
          setActiveMode(restored);
          showInfo(
            `yolo expired after ${Math.round(YOLO_MAX_DURATION_MS / 60_000)} min — restored mode ${restored}.`,
          );
        }
      },
      Math.max(remaining, 0),
    );
    return () => clearTimeout(timer);
  }, [activeMode]);

  const noteTurnStart = useCallback((): void => {
    if (activeMode === "yolo") {
      if (yoloTurnCountRef.current >= YOLO_MAX_TURNS) {
        const restored = preYoloModeRef.current;
        yoloArmedAtRef.current = null;
        yoloTurnCountRef.current = 0;
        setActiveMode(restored);
        showInfo(`yolo expired after ${YOLO_MAX_TURNS} turns — restored mode ${restored}.`);
      } else {
        yoloTurnCountRef.current += 1;
      }
    }
  }, [activeMode, showInfo]);

  const consumeArmAnswer = useCallback(
    (trimmed: string): boolean => {
      if (!awaitingYoloArm) return false;
      setAwaitingYoloArm(false);
      if (trimmed.toLowerCase() === "yes") {
        yoloArmedAtRef.current = Date.now();
        yoloTurnCountRef.current = 0;
        setActiveMode("yolo");
        showInfo(
          "yolo armed — destructive tools will not prompt. Auto-disarms after " +
            `${YOLO_MAX_TURNS} turns or ${Math.round(YOLO_MAX_DURATION_MS / 60_000)} min. Type \`/yolo off\` to disarm now.`,
        );
      } else {
        showInfo(`/yolo: cancelled — staying in ${preYoloModeRef.current}.`);
      }
      return true;
    },
    [awaitingYoloArm, showInfo],
  );

  const runYoloSlash = useCallback(
    (trimmed: string, hasPendingElicitation: boolean): void => {
      if (hasPendingElicitation) {
        showError("/yolo: cannot arm while an elicitation is pending — resolve it first.");
        return;
      }
      const arg = trimmed.split(/\s+/).slice(1)[0]?.toLowerCase();
      if (arg === "off" || arg === "disarm") {
        if (activeMode !== "yolo") {
          showInfo("/yolo: not currently armed.");
          return;
        }
        yoloArmedAtRef.current = null;
        yoloTurnCountRef.current = 0;
        setActiveMode(preYoloModeRef.current);
        setAwaitingYoloArm(false);
        showInfo(`/yolo: disarmed — restored mode ${preYoloModeRef.current}.`);
        return;
      }
      if (activeMode === "yolo") {
        showInfo("/yolo: already armed. Type `/yolo off` to disarm.");
        return;
      }
      if (awaitingYoloArm) {
        showInfo("/yolo: already awaiting confirmation — type `yes` to arm.");
        return;
      }
      preYoloModeRef.current = activeMode;
      setAwaitingYoloArm(true);
      showInfo(
        "/yolo: type `yes` (literally) and Enter to arm. " +
          "Yolo lifts the delete/revoke/approve confirmation gate for the " +
          "next 10 turns / 10 min. Anything else cancels.",
      );
    },
    [activeMode, awaitingYoloArm, showError, showInfo],
  );

  return {
    activeMode,
    setActiveMode,
    awaitingYoloArm,
    noteTurnStart,
    consumeArmAnswer,
    runYoloSlash,
  };
}
