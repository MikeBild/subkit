import type { ActivityState } from "@cli-core/index.ts";
import { Text } from "ink";
import { memo, useEffect, useRef, useState } from "react";

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
  activity: ActivityState | null;
  active: boolean;
}

const ActivityLineImpl: React.FC<ActivityLineProps> = ({ activity, active }) => {
  const throttled = useThrottledActivity(activity);
  if (!active || !throttled) return null;
  const glyph = PHASE_GLYPH[throttled.phase];
  const color = PHASE_COLOR[throttled.phase];
  const elapsedMs = Math.max(0, Date.now() - throttled.updated_at);
  const elapsedHint =
    throttled.phase === "composing" && elapsedMs >= 2000
      ? ` · ${(elapsedMs / 1000).toFixed(1)}s`
      : "";
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
