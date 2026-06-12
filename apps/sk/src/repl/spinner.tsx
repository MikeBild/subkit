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
  /**
   * Name of the tool currently executing on the engine, if any.
   * When set, the spinner replaces the rotating verb with a
   * concrete "running <tool_name>" line so the user sees real
   * progress instead of just "thinking…" for 1m+. Pre-fix session
   * 86de186b: the engine ran build_workflow → validate_draft →
   * dry_run_workflow over 1m20s while the CLI showed only
   * "thinking… 1m16s". Mirrors reference impl's per-tool ticker.
   */
  currentTool?: string | null;
  /**
   * Optional descriptor of the tool's current substep, surfaced
   * after the tool name (e.g. "running fetch_projects (request)").
   */
  currentToolKind?: string | null;
  /**
   * Number of tool calls that COMPLETED this turn but no tool is
   * currently in flight. When non-zero and `currentTool` is null,
   * the spinner switches from a generic verb to "processing N
   * tool result(s)…" so the user sees concrete progress during the
   * LLM's pure-compose phase rather than a random rotating verb.
   * Pre-fix session dcdcf246: spinner showed "considering… 12s",
   * "composing… 8s", "reviewing… 18s" with no signal that the
   * engine had already finished its tool work. The label
   * deliberately says "processing", NOT "summarising" — no
   * summarization call exists; the model is simply composing over
   * the accumulated results (session 784c1b02 read the old label
   * as a real compaction step that never happened).
   */
  completedToolsThisTurn?: number;
  /**
   * Number of tool calls that FAILED this turn. Surfaced inside
   * the spinner head when ≥2, alongside the last failure's
   * structured `error_code` if known. Lets the user see "5 tools
   * failed (slug_already_in_use) · 3m09s" instead of an opaque
   * "processing 5 tool results…" — exactly the symptom in
   * session 975a64b0 where the LLM spent 3m09s burning tokens on a
   * recovery flow that started with a 23505 surfaced as a raw SQL
   * error string.
   */
  failedToolsThisTurn?: number;
  /**
   * Optional structured error_code from the most recent failed
   * tool call. Rendered after the failure count for transparency.
   */
  lastFailureCode?: string | null;
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

  // Stable layout: always reserve a single row + bottom margin so
  // composer doesn't jump up/down between busy/idle turns. When idle
  // we render an empty Text inside the same Box height so the
  // surrounding stack does not reflow. The user reported "composer
  // springt" across consecutive turns — that was Spinner returning
  // null toggling the surrounding flex column's row count.
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
  // Concrete progress line when a tool is in flight: "running
  // dry_run_workflow…  1m16s · 204879t". When no tool is in flight
  // BUT tools have completed this turn, switch to "processing N
  // tool result(s)…" so the user sees concrete pipeline progress
  // during the LLM's compose phase. Verb rotation is the last-
  // resort fallback (pure thinking, no tools yet).
  // "processing", NOT "summarising": no summarization call exists in
  // the engine — the old label invented a step that never ran.
  // Failure-aware head: when ≥2 tools have failed in this turn, the
  // spinner surfaces the failure count + last error code so the user
  // sees a concrete "5 tools failed (slug_already_in_use)" instead
  // of a misleading "processing 5 tool results" — which suggests
  // the LLM is wrapping up when it's actually still recovering.
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
