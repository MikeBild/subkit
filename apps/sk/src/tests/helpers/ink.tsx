// Canonical helper for testing ink components.
//
// Why this file exists:
//   - Ink-testing-library's `render()` returns a frame that includes
//     raw ANSI escapes, which makes substring assertions brittle.
//     `text()` strips them.
//   - Ink has no built-in `act()`; flushing renders requires a
//     microtask-level yield (`setImmediate`). `flush()` encapsulates
//     that so tests don't reinvent it.
//   - Centralizing the key-byte table means every test presses "ctrl+c"
//     the same way.
//
// Usage:
//   import { renderInk, KEYS } from "./helpers/ink.tsx";
//   const ui = renderInk(<MyComponent />);
//   try {
//     ui.press("enter");
//     await ui.waitFor((t) => t.includes("saved"));
//     expect(ui.text()).toContain("saved");
//   } finally {
//     ui.unmount();
//   }
//
// No frame snapshots by default — the frame is text after ANSI stripping
// but column widths and whitespace still vary with terminal size. Prefer
// substring / regex assertions.

import { render as inkRender } from "ink-testing-library";
import type React from "react";

/** Strip ANSI escape sequences. Small inline implementation — the
 *  standard npm `strip-ansi` package is overkill for our test surface. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires literal control bytes.
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PRZcf-nqry=><]|\w+)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Canonical key-byte sequences. Covers every key the ink test suite
 *  needs; add entries here rather than inlining bytes at call sites. */
export const KEYS = {
  up: "\u001B[A",
  down: "\u001B[B",
  right: "\u001B[C",
  left: "\u001B[D",
  enter: "\r",
  esc: "\u001B",
  tab: "\t",
  shiftTab: "\u001B[Z",
  backspace: "\x7F",
  del: "\u001B[3~",
  home: "\u001B[H",
  end: "\u001B[F",
  pageUp: "\u001B[5~",
  pageDown: "\u001B[6~",
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlK: "\x0B",
  ctrlL: "\x0C",
  ctrlN: "\x0E",
  ctrlP: "\x10",
  ctrlU: "\x15",
  ctrlW: "\x17",
} as const;

export type KeyName = keyof typeof KEYS;

/** Flush one macrotask tick so ink/react effects settle. Equivalent to
 *  `await new Promise(r => setImmediate(r))`. */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export interface RenderInkInstance {
  /** Raw ink-testing-library instance for escape hatches. */
  raw: ReturnType<typeof inkRender>;
  /** Current frame with ANSI stripped. */
  text(): string;
  /** All frames captured so far (ANSI-stripped). */
  frames(): string[];
  /** Raw frame including ANSI. */
  rawText(): string;
  /** Write a string to stdin. */
  type(s: string): Promise<void>;
  /** Press a named key. */
  press(k: KeyName): Promise<void>;
  /** Press a sequence of keys. */
  pressAll(keys: KeyName[]): Promise<void>;
  /** Wait for a predicate on the stripped frame to hold. */
  waitFor(
    pred: (frame: string) => boolean,
    opts?: { tries?: number; label?: string; sleepMs?: number },
  ): Promise<void>;
  /** Flush effects. */
  flush(): Promise<void>;
  /** Unmount (call in finally). */
  unmount(): void;
}

export function renderInk(ui: React.ReactElement): RenderInkInstance {
  const instance = inkRender(ui);
  const text = (): string => stripAnsi(instance.lastFrame() ?? "");
  const rawText = (): string => instance.lastFrame() ?? "";
  const frames = (): string[] => instance.frames.map(stripAnsi);

  const typeStr = async (s: string): Promise<void> => {
    instance.stdin.write(s);
    await flush();
  };
  const press = async (k: KeyName): Promise<void> => {
    instance.stdin.write(KEYS[k]);
    await flush();
  };
  const pressAll = async (keys: KeyName[]): Promise<void> => {
    for (const k of keys) await press(k);
  };

  const waitFor = async (
    pred: (frame: string) => boolean,
    {
      tries = 100,
      label = "ink waitFor",
      sleepMs = 0,
    }: { tries?: number; label?: string; sleepMs?: number } = {},
  ): Promise<void> => {
    for (let i = 0; i < tries; i++) {
      if (pred(text())) return;
      await flush();
      if (sleepMs > 0) {
        // allow-wall-clock: macrotask waits — callers opt in via
        // `sleepMs` when the predicate depends on a setTimeout
        // resolution (e.g. backoff schedules, debounced effects).
        await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      }
    }
    throw new Error(`${label} timed out after ${tries} polls.\nlast frame:\n${text()}`);
  };

  return {
    raw: instance,
    text,
    frames,
    rawText,
    type: typeStr,
    press,
    pressAll,
    waitFor,
    flush,
    unmount: () => instance.unmount(),
  };
}

/** Pin common env knobs so ink renders deterministically (color off, CI
 *  flag on, fixed column width). Call once in a test file's top scope
 *  or inside a beforeAll. */
export function pinInkEnv(): void {
  process.env.FORCE_COLOR = "0";
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  // Ink's flex math reads columns from stdout; default to 80 for
  // reproducible layout. Only pin when the stream supports it.
  const s = process.stdout as unknown as { columns?: number };
  if (typeof s.columns === "number") s.columns = 80;
}
