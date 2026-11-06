import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@cli-core/index.ts";
import { render } from "ink-testing-library";
import { EngineClient } from "../engine-client.ts";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

export async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

export const ADMIN: PersonaProbe = { allows: () => true };

export const dirs: string[] = [];

export function tmpHist(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-feat-hist-"));
  dirs.push(d);
  return join(d, "history.jsonl");
}

export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-feat-"));
  dirs.push(d);
  return d;
}

function defaultProps(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "acme",
      engineUrl: "http://localhost:8080",
      profileName: "feat",
      probe: ADMIN,
    },
    statusLineConfig: { format: "", refreshMs: 999_999 },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: tmpDir(),
    historyPath: tmpHist(),
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c-0000-0000-0000-000000000000",
    }),
    ...overrides,
  };
}

export async function tick(ms = 30): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
  await new Promise((r) => setTimeout(r, ms));
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

export function stripAnsi(frame: string): string {
  const ansiPattern = `${String.fromCharCode(27)}\\[[0-9;]*m`;
  return frame.replace(new RegExp(ansiPattern, "g"), "");
}

export function renderApp(overrides: Partial<InkAppProps> = {}) {
  return render(<InkApp {...defaultProps(overrides)} />);
}

const NOW = "2026-01-01T00:00:00.000Z";

interface FakeUpload {
  fid: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export function makeFakeEngine(uploads: FakeUpload[]): EngineClient {
  let i = 0;
  return new EngineClient({
    engine_url: "http://engine.local",
    api_key: "wf_live_test",
    tenant: "acme",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/v1/files/inline")) {
        const u = uploads[i++] ?? uploads[uploads.length - 1];
        if (!u) throw new Error("no upload fixture");
        return new Response(
          JSON.stringify({
            id: u.fid,
            status: "ready",
            filename: u.filename,
            content_type: u.content_type,
            size_bytes: u.size_bytes,
            sha256: "deadbeef",
            scan_result: null,
            created_at: NOW,
            updated_at: NOW,
            deleted_at: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/links")) {
        return new Response(JSON.stringify({ id: "link-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}
