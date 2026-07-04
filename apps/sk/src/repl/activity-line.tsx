// Single-line activity ticker rendered between the transcript and the
// spinner. Reads from `session.activity` (set by the cli-core reducer
// in response to `TurnEvent.type === "activity"` frames the engine
// emits at meaningful phase boundaries).
//
// Why this exists: pre-fix the user saw `summarising 28 tool results
// · 1m43s · 370886t` for the entire LLM-text-composition phase — no
// hint that the engine was waiting on the model rather than stuck in
// a tool. The activity line keeps the ticker accurate even when the
// tool-call card has scrolled out of view.
//
// Layout:
//   - One fixed-position line, distinct from the transcript.
//   - Phase strings are dynamic, not a closed enum (we keep three
//     coarse phases — tool / composing / idle — but render the
//     `label` field free-form).
//   - Prefer visibility over silence: render the line whenever the
//     turn is busy. An empty ticker hides as soon as the turn ends.
//
// Anti-flicker: the engine throttles `activity` emission at 200ms in
// EventSink. The component additionally debounces incoming state
// changes at 250ms via `useThrottledActivity` so a burst of identical
// frames re-renders exactly once.

import type { ActivityState } from "@cli-core/index.ts";
import { Text } from "ink";
import { memo, useEffect, useRef, useState } from "react";

/** Throttle helper. The Ink renderer locks at 30fps; combining that
 *  with a 250ms state debounce keeps the bottom-pane redraw quiet
 *  enough that the operator sees one update per phase transition,
 *  never per individual TurnEvent. */
function useThrottledActivity(current: ActivityState | null, delayMs = 250): ActivityState | null {
  const [value, setValue] = useState<ActivityState | null>(current);
  const lastFlushRef = useRef<number>(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const since = now - lastFlushRef.current;
    if (since >= delayMs) {
      lastFlushRef.current = now;
      setValue(current);
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      return;
    }
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      lastFlushRef.current = Date.now();
      pendingTimerRef.current = null;
      setValue(current);
    }, delayMs - since);
    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, [current, delayMs]);

  return value;
}

const PHASE_GLYPH: Record<ActivityState["phase"], string> = {
  tool: "▶",
  composing: "↻",
  idle: "·",
};

const PHASE_COLOR: Record<ActivityState["phase"], "cyan" | "yellow" | "gray"> = {
  tool: "cyan",
  composing: "yellow",
  idle: "gray",
};

interface ActivityLineProps {
  /** Latest payload from session state. `null` means no activity. */
  activity: ActivityState | null;
  /** When false the line stays hidden — used to suppress the ticker
   *  outside an active turn. The spinner already handles the "no work
   *  in flight" state with its own affordance. */
  active: boolean;
}

const ActivityLineImpl: React.FC<ActivityLineProps> = ({ activity, active }) => {
  const throttled = useThrottledActivity(activity);
  if (!active || !throttled) return null;
  const glyph = PHASE_GLYPH[throttled.phase];
  const color = PHASE_COLOR[throttled.phase];
  // Include compact elapsed time in the same line so
  // the operator can tell at a glance whether the engine is making
  // progress or has gone quiet.
  const elapsedMs = Math.max(0, Date.now() - throttled.updated_at);
  const elapsedHint =
    throttled.phase === "composing" && elapsedMs >= 2000
      ? ` · ${(elapsedMs / 1000).toFixed(1)}s`
      : "";
  // Esc-to-interrupt affordance — render
  // "(esc to interrupt)" for any phase that's been active long enough
  // that a stuck operator would want to bail. Show after 5s, suppress
  // when `phase: "idle"` (the engine isn't actively spinning then).
  const showInterruptHint = throttled.phase !== "idle" && elapsedMs >= 5000;
  return (
    <Text color={color}>
      {glyph} {throttled.label}
      {elapsedHint}
      {showInterruptHint ? <Text dimColor> · esc to interrupt</Text> : null}
    </Text>
  );
};

export const ActivityLine = memo(ActivityLineImpl);
ActivityLine.displayName = "ActivityLine";
