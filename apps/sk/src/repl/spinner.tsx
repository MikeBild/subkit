import { Box, Text } from "ink";
import type React from "react";
import { memo, useEffect, useState } from "react";

export const SPINNER_VERBS: readonly string[] = [
  "thinking",
  "planning",
  "drafting",
  "composing",
  "grounding",
  "considering",
  "stitching",
  "reviewing",
  "deliberating",
  "reasoning",
] as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${rem.toString().padStart(2, "0")}s`;
}

export interface SpinnerProps {
  active: boolean;
  turnTokens?: number | null;
  currentTool?: string | null;
  currentToolKind?: string | null;
  completedToolsThisTurn?: number;
  failedToolsThisTurn?: number;
  lastFailureCode?: string | null;
  verbs?: readonly string[];
  frameMs?: number;
  verbMs?: number;
}

const SpinnerImpl: React.FC<SpinnerProps> = ({
  active,
  turnTokens,
  currentTool,
  currentToolKind,
  completedToolsThisTurn = 0,
  failedToolsThisTurn = 0,
  lastFailureCode = null,
  verbs = SPINNER_VERBS,
  frameMs = 120,
  verbMs = 2500,
}) => {
  const [frame, setFrame] = useState(0);
  const [verbIndex, setVerbIndex] = useState(() => Math.floor(Math.random() * verbs.length));
  const [startedAt, setStartedAt] = useState<number | null>(active ? Date.now() : null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (active) {
      setStartedAt(Date.now());
      setNow(Date.now());
    } else {
      setStartedAt(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, frameMs);
    return () => {
      clearInterval(id);
    };
  }, [active, frameMs]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setVerbIndex((v) => (v + 1) % verbs.length);
    }, verbMs);
    return () => {
      clearInterval(id);
    };
  }, [active, verbMs, verbs.length]);

  if (!active) {
    return (
      <Box marginBottom={1}>
        <Text> </Text>
      </Box>
    );
  }

  const glyph = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
  const verb = verbs[verbIndex] ?? verbs[0] ?? "thinking";
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  const tokens = typeof turnTokens === "number" && turnTokens > 0 ? ` · ${turnTokens}t` : "";
  const failureHead =
    failedToolsThisTurn >= 2
      ? `${failedToolsThisTurn} tools failed${lastFailureCode ? ` (${lastFailureCode})` : ""}`
      : null;
  const headLabel = currentTool
    ? `running ${currentTool}${currentToolKind ? ` (${currentToolKind})` : ""}`
    : (failureHead ??
      (completedToolsThisTurn > 0
        ? `processing ${completedToolsThisTurn} tool result${completedToolsThisTurn === 1 ? "" : "s"}`
        : verb));
  const headColor = failureHead && !currentTool ? "red" : "yellow";

  const isFailureHead = Boolean(failureHead) && !currentTool;
  return (
    <Box marginBottom={1}>
      <Text color={headColor}>{glyph} </Text>
      {isFailureHead ? (
        <Text bold color="red">
          {headLabel}…
        </Text>
      ) : (
        <Text bold>{headLabel}…</Text>
      )}
      <Text dimColor>
        {"  "}
        {elapsed}
        {tokens}
      </Text>
    </Box>
  );
};

export const Spinner = memo(SpinnerImpl);
