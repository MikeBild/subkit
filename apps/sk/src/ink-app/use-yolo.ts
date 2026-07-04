// Permission-mode state + the yolo arming/expiry state machine.
//
// `yolo` lifts the delete/revoke/approve confirmation gate, so it is
// deliberately hard to arm (explicit `/yolo` + literal `yes`) and
// impossible to leave armed forever (10-turn / 10-minute auto-disarm,
// whichever comes first). The hook owns every piece of that lifecycle
// so the submit path only calls three verbs: `noteTurnStart`,
// `consumeArmAnswer`, `runYoloSlash`.

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode } from "../repl/status-line/render.ts";

const YOLO_MAX_TURNS = 10;
const YOLO_MAX_DURATION_MS = 10 * 60 * 1000;

export interface YoloApi {
  activeMode: PermissionMode;
  setActiveMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  awaitingYoloArm: boolean;
  /** Per-submit yolo expiry bookkeeping — call once per plain submit. */
  noteTurnStart: () => void;
  /**
   * Yolo arming intercept. The `/yolo` slash set the awaiting flag;
   * the very next submit must be the literal `yes`. Returns true when
   * the submission was consumed (armed or cancelled) and must not
   * reach the engine.
   */
  consumeArmAnswer: (trimmed: string) => boolean;
  /** Handles the `/yolo [off]` slash command. */
  runYoloSlash: (trimmed: string, hasPendingElicitation: boolean) => void;
}

export function useYoloMode(
  initialMode: PermissionMode,
  showInfo: (message: string) => void,
  showError: (message: string) => void,
): YoloApi {
  // Permission mode — cycled by Shift-Tab through ask/auto/plan. yolo
  // is intentionally NOT in the cycle: it must be armed explicitly via
  // the `/yolo` slash command (with a typed-yes confirmation) and
  // expires automatically after 10 turns / 10 minutes whichever comes
  // first. Seed from the prop so hosts that persist a preference can
  // drive it, but own the state locally once the user interacts.
  const [activeMode, setActiveMode] = useState<PermissionMode>(initialMode);
  // Tracks the previous sticky mode so `/yolo off` (or auto-expiry)
  // can restore exactly what the operator had selected before arming.
  const preYoloModeRef = useRef<PermissionMode>(initialMode);
  // Yolo arming guard — when set, the next composer submission must
  // be the literal `yes` to confirm arming. Anything else cancels.
  const [awaitingYoloArm, setAwaitingYoloArm] = useState<boolean>(false);
  // yolo expiry tracking. Both counters reset every time yolo arms.
  const yoloArmedAtRef = useRef<number | null>(null);
  const yoloTurnCountRef = useRef<number>(0);

  // Yolo time-based expiry. When yolo is armed, schedule a single
  // disarm at YOLO_MAX_DURATION_MS after the arming time. Reuse
  // `activeMode` as the dependency: arming sets it to "yolo" so this
  // effect fires; disarming sets it back, which invalidates the
  // pending timer via the cleanup. The turn-based path in
  // `handleSubmit` covers the case of an active operator hitting the
  // 10-turn ceiling first.
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

  // Yolo expiry — by-turn. Auto-disarms after YOLO_MAX_TURNS
  // turns so a tab left open mid-task doesn't keep destructive
  // confirmations bypassed indefinitely.
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
      // Refuse arming while a confirmation is pending — the
      // operator might resolve a confirm-step under a mode they
      // didn't intend, which is exactly the foot-gun yolo opens
      // up.
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
