import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import { REQUEST_CREDENTIAL_FORM_FALLBACK } from "../lib/secret-shape.ts";
import type { PersonaProbe } from "../slash.ts";

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

const ADMIN: PersonaProbe = { allows: () => true };

const dirs: string[] = [];
function tmpHist(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-secret-hist-"));
  dirs.push(d);
  return join(d, "history.jsonl");
}
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-secret-cwd-"));
  dirs.push(d);
  return d;
}

function defaultProps(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "acme",
      engineUrl: "http://localhost:8080",
      profileName: "test",
      probe: ADMIN,
    },
    statusLineConfig: { format: "", refreshMs: 999_999 },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: tmpDir(),
    historyPath: tmpHist(),
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c-test",
    }),
    ...overrides,
  };
}

const macrotask: (cb: () => void, ms: number) => unknown = (
  globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => unknown }
).setTimeout;

async function tick(ms = 30): Promise<void> {
  await new Promise<void>((resolve) => {
    macrotask(() => resolve(), ms);
  });
}

async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch);
    await new Promise((r) => setImmediate(r));
  }
  await tick(5);
}

async function pressEnter(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write("\r");
  await tick(40);
}

afterEach(() => {
  cleanup();
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
});

const DOP_TOKEN = "dop_v1_a9053683ac4c864800f693f0c7b325d880a44f056bd884c8d975db2ece655796";

describe("composer: input-side credential filter", () => {
  test("paste of a dop_v1_… token is intercepted before reaching onPrompt", async () => {
    const calls: Array<{ text: string; opts: Parameters<InkAppProps["onPrompt"]>[1] }> = [];
    const instance = render(
      <InkApp
        {...defaultProps({
          onPrompt: async (text, opts) => {
            calls.push({ text, opts });
            return {
              events: framesOf({ type: "completed", status: "active" }),
              conversationId: "c-secret",
            };
          },
        })}
      />,
    );
    await tick();

    await type(instance, DOP_TOKEN);
    await pressEnter(instance);
    await tick(40);

    expect(calls).toHaveLength(0);

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("digitalocean pat");
    expect(frame).toContain("dop_v1");
    expect(frame).toContain("masked form");
    expect(frame).not.toContain(DOP_TOKEN);

    await pressEnter(instance);
    await tick(40);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.event).toEqual({
      type: "request_credential_form",
      credential_hint: "digitalocean_pat",
    });
    expect(calls[0]?.text).toBe(REQUEST_CREDENTIAL_FORM_FALLBACK);
    expect(calls[0]?.text).not.toContain(DOP_TOKEN);
    expect(JSON.stringify(calls[0])).not.toContain(DOP_TOKEN);
    instance.unmount();
  });

  test("Esc cancels an armed redirect without sending anything", async () => {
    const calls: string[] = [];
    const instance = render(
      <InkApp
        {...defaultProps({
          onPrompt: async (text) => {
            calls.push(text);
            return {
              events: framesOf({ type: "completed", status: "active" }),
              conversationId: "c-secret",
            };
          },
        })}
      />,
    );
    await tick();
    await type(instance, DOP_TOKEN);
    await pressEnter(instance);
    await tick(40);

    instance.stdin.write("\x1b");
    await tick(40);

    expect(calls).toHaveLength(0);

    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("Press Enter to confirm");
    instance.unmount();
  });

  test("plain prose without a credential is forwarded normally", async () => {
    const calls: string[] = [];
    const instance = render(
      <InkApp
        {...defaultProps({
          onPrompt: async (text) => {
            calls.push(text);
            return {
              events: framesOf({ type: "completed", status: "active" }),
              conversationId: "c-plain",
            };
          },
        })}
      />,
    );
    await tick();
    await type(instance, "set up a digitalocean connector for me");
    await pressEnter(instance);
    await tick(40);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("set up a digitalocean connector for me");
    instance.unmount();
  });
});
