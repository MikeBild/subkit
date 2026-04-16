// Animated thinking spinner with rotating verbs, elapsed timer,
// and optional token counter — modeled after Claude Code's
// SpinnerWithVerb component. Visible only while a turn is
// streaming; hidden when the REPL is idle or awaiting approval.
//
// The component intentionally keeps its own interval state
// (no animation ref tricks) because sk's update volume is small
// compared to claude-code's streaming frames. The spinner only
// re-renders four times per second at most.

import { Box, Text } from "ink";
import type React from "react";
import { memo, useEffect, useState } from "react";

/**
 * Rotating verbs that replace "thinking" — keeps the spinner
 * feeling alive across long turns. Order is deterministic so
 * tests can assert on the first verb, but the starting index is
 * randomized per mount.
 */
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

/** Braille spinner frames — 8 frames, standard Unicode sequence. */
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
  /** Whether the spinner should be actively animating. */
  active: boolean;
  /**
   * Tokens accumulated on the current turn. Surfaced next to the
   * elapsed timer when non-null.
   */
  turnTokens?: number | null;
  /** Override the verb list (tests). */
  verbs?: readonly string[];
  /** Frame duration in ms. Default 120ms. */
  frameMs?: number;
  /** Verb rotation period in ms. Default 2500ms. */
  verbMs?: number;
}

const SpinnerImpl: React.FC<SpinnerProps> = ({
  active,
  turnTokens,
  verbs = SPINNER_VERBS,
  frameMs = 120,
  verbMs = 2500,
}) => {
  const [frame, setFrame] = useState(0);
  const [verbIndex, setVerbIndex] = useState(() => Math.floor(Math.random() * verbs.length));
  const [startedAt, setStartedAt] = useState<number | null>(active ? Date.now() : null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Reset the timer whenever the spinner flips from inactive→active.
  useEffect(() => {
    if (active) {
      setStartedAt(Date.now());
      setNow(Date.now());
    } else {
      setStartedAt(null);
    }
  }, [active]);

  // Spinner-frame ticker — rotates the braille glyph. Cleared when
  // the spinner goes inactive so we don't leak timers.
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

  // Verb-rotation ticker — independent cadence so the verb stays
  // on-screen long enough to read.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setVerbIndex((v) => (v + 1) % verbs.length);
    }, verbMs);
    return () => {
      clearInterval(id);
    };
  }, [active, verbMs, verbs.length]);

  if (!active) return null;

  const glyph = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
  const verb = verbs[verbIndex] ?? verbs[0] ?? "thinking";
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  const tokens = typeof turnTokens === "number" && turnTokens > 0 ? ` · ${turnTokens}t` : "";

  return (
    <Box marginBottom={1}>
      <Text color="yellow">{glyph} </Text>
      <Text bold>{verb}…</Text>
      <Text dimColor>
        {"  "}
        {elapsed}
        {tokens}
      </Text>
    </Box>
  );
};

export const Spinner = memo(SpinnerImpl);
