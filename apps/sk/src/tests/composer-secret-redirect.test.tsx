// PR5 Ink-side test for the input credential filter.
//
// Mounts <InkApp> with `ink-testing-library` and pastes a real-shape
// DigitalOcean PAT. Asserts:
//   - the literal token is NOT visible in the rendered frame
//     (no leak into transcript / composer);
//   - the redirect hint IS shown with the safe 6-char prefix sample;
//   - submitting again sends the masked nudge (not the original token)
//     to `onPrompt`;
//   - Esc clears the redirect without sending anything.
//
// Tests use a tmp history path so they don't touch ~/.sk.

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

async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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
      } catch {
        // ignore
      }
    }
  }
});

// Real-shape DigitalOcean PAT that mirrors session 00b93a52-… The
// token is invented (random hex), but its prefix + length match the
// production format so the detector treats it as a real positive.
const DOP_TOKEN = "dop_v1_a9053683ac4c864800f693f0c7b325d880a44f056bd884c8d975db2ece655796";

describe("composer: input-side credential filter", () => {
  test("paste of a dop_v1_… token is intercepted before reaching onPrompt", async () => {
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

    // Type-out the token (each char individually) so it ends up in the
    // input buffer verbatim, not stashed as a paste ref. Mirrors the
    // session-00b93a52 paste path because that token was short enough
    // to inline.
    await type(instance, DOP_TOKEN);
    await pressEnter(instance);
    await tick(40);

    // The original token MUST NOT have been forwarded to the engine.
    expect(calls).toHaveLength(0);

    // The composer should now show the redirect hint with the kind
    // label and a 6-char sample, but NOT the literal token.
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("digitalocean pat");
    expect(frame).toContain("dop_v1");
    expect(frame).toContain("masked form");
    // Critical: the full token never appears on screen.
    expect(frame).not.toContain(DOP_TOKEN);

    // Press Enter again to confirm the redirect — the engine should
    // receive the masked nudge instead of the raw paste.
    await pressEnter(instance);
    await tick(40);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(REQUEST_CREDENTIAL_FORM_FALLBACK);
    expect(calls[0]).not.toContain(DOP_TOKEN);
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

    // Esc keystroke — should clear the buffer + dismiss the redirect.
    instance.stdin.write("\x1b");
    await tick(40);

    // Nothing reached the engine, on either submit attempt.
    expect(calls).toHaveLength(0);

    // Buffer is empty / hint cleared.
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

    // Non-credential prompt goes through to onPrompt verbatim.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("set up a digitalocean connector for me");
    instance.unmount();
  });
});
