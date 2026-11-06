import { render as inkRender } from "ink-testing-library";
import type React from "react";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires literal control bytes.
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PRZcf-nqry=><]|\w+)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

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

type KeyName = keyof typeof KEYS;

export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface RenderInkInstance {
  raw: ReturnType<typeof inkRender>;
  text(): string;
  frames(): string[];
  rawText(): string;
  type(s: string): Promise<void>;
  press(k: KeyName): Promise<void>;
  pressAll(keys: KeyName[]): Promise<void>;
  waitFor(
    pred: (frame: string) => boolean,
    opts?: { tries?: number; label?: string; sleepMs?: number },
  ): Promise<void>;
  flush(): Promise<void>;
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
