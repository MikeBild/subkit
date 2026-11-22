import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@cli-core/index.ts";
import { render } from "ink-testing-library";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

export async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

export function stripAnsi(frame: string): string {
  const ansiPattern = `${String.fromCharCode(27)}\\[[0-9;]*m`;
  return frame.replace(new RegExp(ansiPattern, "g"), "");
}

export const PERSONAS = {
  admin: { allows: () => true } as PersonaProbe,
  member: { allows: (p: string) => p !== "audit:read" } as PersonaProbe,
  enduser: {
    allows: (p: string) =>
      new Set([
        "conversation:read",
        "conversation:write",
        "conversation:cancel",
        "conversation:list",
      ]).has(p),
  } as PersonaProbe,
  portal: {
    allows: (p: string) =>
      new Set(["conversation:read", "conversation:write", "conversation:cancel"]).has(p),
  } as PersonaProbe,
};

export const histDirs: string[] = [];

function tmpHistory(): string {
  const d = mkdtempSync(join(tmpdir(), "subkit-ink-hist-"));
  histDirs.push(d);
  return join(d, "history.jsonl");
}

function defaultProps(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "tenant-alpha",
      engineUrl: "http://localhost:8080",
      profileName: "journey",
      probe: PERSONAS.admin,
    },
    statusLineConfig: {
      format: "{persona}@{tenant} · {model} · {turn_tokens}t",
      refreshMs: 999_999,
    },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/ws",
    historyPath: tmpHistory(),
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c0-00000000-0000-0000-0000-000000000000",
    }),
    ...overrides,
  };
}

export async function tick(ms = 30): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitForFrame(
  instance: ReturnType<typeof renderApp>,
  pred: (frame: string) => boolean,
  { maxMs = 2000, stepMs = 20 }: { maxMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + maxMs; // allow-wall-clock: budget is real ms (CI scheduler pressure, not fake time)
  while (Date.now() < deadline) {
    // allow-wall-clock: see comment above
    const frame = instance.lastFrame() ?? "";
    if (pred(frame)) return;
    await new Promise((r) => setTimeout(r, stepMs)); // allow-wall-clock: paced poll; the ink render commit + scheduler yield need real wall time
  }
}

export async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch);
    await new Promise((r) => setImmediate(r));
  }
  await tick(5);
}

export async function pressEnter(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write("\r");
  await tick(40);
}

export function renderApp(overrides: Partial<InkAppProps> = {}) {
  return render(<InkApp {...defaultProps(overrides)} />);
}
