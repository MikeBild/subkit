import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { EngineClient } from "../engine-client.ts";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import { appendHistory } from "../repl/history-store.ts";
import type { PersonaProbe } from "../slash.ts";

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

const ADMIN: PersonaProbe = { allows: () => true };

const dirs: string[] = [];
function tmpHist(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-feat-hist-"));
  dirs.push(d);
  return join(d, "history.jsonl");
}
function tmpDir(): string {
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

async function tick(ms = 30): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
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

function stripAnsi(frame: string): string {
  const ansiPattern = `${String.fromCharCode(27)}\\[[0-9;]*m`;
  return frame.replace(new RegExp(ansiPattern, "g"), "");
}

function renderApp(overrides: Partial<InkAppProps> = {}) {
  return render(<InkApp {...defaultProps(overrides)} />);
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

describe("features: persistent history", () => {
  test("prior prompts from the history file are loaded on mount", async () => {
    const path = tmpHist();
    appendHistory("first run command", { path, tenant: "acme" });
    appendHistory("second run command", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    instance.stdin.write("\x12");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("reverse-i-search");
    expect(frame).toContain("second run command");
    instance.unmount();
  });

  test("tenant filter isolates history across tenants", async () => {
    const path = tmpHist();
    appendHistory("acme only", { path, tenant: "acme" });
    appendHistory("other only", { path, tenant: "other" });
    const instance = renderApp({
      historyPath: path,
      persona: {
        label: "admin",
        tenant: "acme",
        engineUrl: "http://localhost:8080",
        profileName: "feat",
        probe: ADMIN,
      },
    });
    await tick();
    instance.stdin.write("\x12");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("acme only");
    expect(frame).not.toContain("other only");
    instance.unmount();
  });

  test("submitting a prompt writes it to the history file", async () => {
    const path = tmpHist();
    const instance = renderApp({ historyPath: path });
    await tick();
    await type(instance, "persist me");
    await pressEnter(instance);
    await tick(60);
    const { loadPromptRing } = await import("../repl/history-store.ts");
    const ring = loadPromptRing(path);
    expect(ring).toContain("persist me");
    instance.unmount();
  });
});

describe("features: ↑/↓ history cycling", () => {
  test("↑ cycles back through prior prompts", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "older prompt");
    await pressEnter(instance);
    await tick(40);
    await type(instance, "newer prompt");
    await pressEnter(instance);
    await tick(40);

    instance.stdin.write("\x1b[A");
    await tick(20);
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("newer prompt");
    instance.stdin.write("\x1b[A");
    await tick(20);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("older prompt");
    instance.unmount();
  });

  test("draft is preserved when cycling away and back", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "history entry");
    await pressEnter(instance);
    await tick(40);

    await type(instance, "my-draft");
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("my-draft");
    instance.stdin.write("\x1b[A");
    await tick(20);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("history entry");
    instance.stdin.write("\x1b[B");
    await tick(20);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("my-draft");
    instance.unmount();
  });
});

describe("features: cursor + readline shortcuts", () => {
  test("left arrow moves the cursor left without deleting", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "hello");
    instance.stdin.write("\x1b[D");
    await tick(10);
    await type(instance, "X");
    const frame = instance.lastFrame() ?? "";
    const stripped = stripAnsi(frame).replace(/[▊·]/g, "");
    expect(stripped).toContain("hellXo");
    instance.unmount();
  });

  test("Ctrl-A jumps to line start; Ctrl-E to line end", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "middle");
    instance.stdin.write("\x01");
    await tick(10);
    await type(instance, "[");
    instance.stdin.write("\x05");
    await tick(10);
    await type(instance, "]");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[middle]");
    instance.unmount();
  });

  test("Ctrl-U wipes the whole line", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "kill this");
    instance.stdin.write("\x15");
    await tick(10);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).not.toContain("kill this");
    expect(frame).toMatch(/❯\s+▊/);
    instance.unmount();
  });

  test("Ctrl-W deletes the previous word", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "delete this word");
    instance.stdin.write("\x17");
    await tick(10);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("delete this ");
    expect(frame).not.toContain("word");
    instance.unmount();
  });

  test("Ctrl-K kills to end of line", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "keep me | and drop me");
    for (let i = 0; i < 12; i++) {
      instance.stdin.write("\x1b[D");
    }
    await tick(10);
    instance.stdin.write("\x0b");
    await tick(10);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("keep me");
    expect(frame).not.toContain("drop me");
    instance.unmount();
  });

  test("Ctrl-J inserts a newline for multiline input", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "line one");
    instance.stdin.write("\x0a");
    await tick(10);
    await type(instance, "line two");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    instance.unmount();
  });

  test("Backslash + Enter inserts a newline (universal terminal escape)", async () => {
    const received: { text: string | null } = { text: null };
    const instance = renderApp({
      onPrompt: async (text) => {
        received.text = text;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-bs-enter",
        };
      },
    });
    await tick();
    await type(instance, "first\\");
    await pressEnter(instance);
    expect(received.text).toBeNull();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("first");
    await type(instance, "second");
    await pressEnter(instance);
    await tick(40);
    expect(received.text).toBe("first\nsecond");
    instance.unmount();
  });

  test("Shift+Enter inserts a newline (kitty CSI u protocol)", async () => {
    const received: { text: string | null } = { text: null };
    const instance = renderApp({
      onPrompt: async (text) => {
        received.text = text;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-shift-enter",
        };
      },
    });
    await tick();
    await type(instance, "first");
    instance.stdin.write("\x1b[13;2u");
    await tick(20);
    expect(received.text).toBeNull();
    await type(instance, "second");
    await pressEnter(instance);
    await tick(40);
    expect(received.text).not.toBeNull();
    instance.unmount();
  });

  test("Enter submits the whole multiline buffer as one prompt", async () => {
    let received = "";
    const instance = renderApp({
      onPrompt: async (text) => {
        received = text;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-ml",
        };
      },
    });
    await tick();
    await type(instance, "first");
    instance.stdin.write("\x0a");
    await tick(10);
    await type(instance, "second");
    await pressEnter(instance);
    await tick(60);
    expect(received).toBe("first\nsecond");
    instance.unmount();
  });
});

describe("features: paste heuristic", () => {
  test("a long pasted chunk is replaced by a [Pasted text #N] ref", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write(`${"x".repeat(1001)}\nsecond line of paste`);
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/\[Pasted text #\d+(?: \+\d+ lines)?\]/);
    expect(frame).toContain("paste refs · 1 pending");
    expect(frame).toContain("xxxxxxxx");
    instance.unmount();
  });

  test("a short single-line paste is inserted inline (no attachment)", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write("acme-stock-price");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("acme-stock-price");
    expect(frame).not.toMatch(/\[Pasted text #\d+\]/);
    expect(frame).not.toContain("paste refs · 1 pending");
    instance.unmount();
  });

  test("short bracketed multiline paste remains visible inline", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write("\x1b[200~first line\nsecond line\x1b[201~");
    await tick(40);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("first line");
    expect(frame).toContain("second line");
    expect(frame).not.toMatch(/\[Pasted text #\d+\]/);
    expect(frame).not.toContain("paste refs · 1 pending");
    instance.unmount();
  });

  test("paste refs expand back inline on submit", async () => {
    let received = "";
    const instance = renderApp({
      onPrompt: async (text) => {
        received = text;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-paste",
        };
      },
    });
    await tick();
    const body = `${"x".repeat(1001)}\nline\npaste content`;
    instance.stdin.write(body);
    await tick(30);
    instance.stdin.write("\r");
    await tick(60);
    expect(received).toContain("x".repeat(1001));
    expect(received).toContain("line");
    expect(received).toContain("paste content");
    instance.unmount();
  });

  test("paste refs are preserved when submit fails", async () => {
    const instance = renderApp({
      onPrompt: async () => {
        throw new Error("network down");
      },
    });
    await tick();
    instance.stdin.write("x".repeat(1001));
    await tick(30);
    await pressEnter(instance);
    await tick(80);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("paste refs · 1 pending");
    expect(frame).toMatch(/\[Pasted text #\d+/);
    expect(frame).toContain("network down");
    instance.unmount();
  });

  test("oversized expanded paste is rejected without losing the paste ref", async () => {
    let called = false;
    const instance = renderApp({
      onPrompt: async () => {
        called = true;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-too-large",
        };
      },
    });
    await tick();
    instance.stdin.write("x".repeat(1_048_577));
    await tick(30);
    await pressEnter(instance);
    await tick(80);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(called).toBe(false);
    expect(frame).toContain("Message exceeds the maximum length");
    expect(frame).toContain("paste refs · 1 pending");
    instance.unmount();
  });

  test("bracketed paste of a text file path stays visible and reads on submit", async () => {
    const dir = tmpDir();
    const mdPath = join(dir, "slides.md");
    writeFileSync(mdPath, "# Slides");
    const fid = "fid_00000000-0000-0000-0000-000000000003";
    const engineClient = makeFakeEngine([
      { fid, filename: "slides.md", content_type: "text/markdown", size_bytes: 8 },
    ]);
    const prompts: string[] = [];
    const instance = renderApp({
      cwd: dir,
      engineClient,
      onPrompt: async (text) => {
        prompts.push(text);
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    instance.stdin.write(`\x1b[200~${mdPath}\x1b[201~`);
    await tick(40);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain(mdPath);
    expect(frame).not.toContain(fid);
    expect(frame).not.toContain('"$file"');
    expect(frame).not.toMatch(/\[Pasted text #\d+\]/);
    await pressEnter(instance);
    await tick(80);
    expect(prompts[0]).toContain(mdPath);
    expect(prompts[0]).toContain("## Local file contents: slides.md");
    expect(prompts[0]).toContain("# Slides");
    expect(prompts[0]).not.toContain(fid);
    expect(prompts[0]).not.toContain('"$file"');
    instance.unmount();
  });
});

describe("features: busy-turn queue", () => {
  test("typing a prompt while busy enqueues instead of duplicating", async () => {
    const resolvers: Array<() => void> = [];
    const seen: string[] = [];
    const instance = renderApp({
      onPrompt: async (text) => {
        seen.push(text);
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: `c-q-${seen.length}`,
        };
      },
    });
    await tick();
    await type(instance, "first");
    await pressEnter(instance);
    await tick(20);
    await type(instance, "queued one");
    await pressEnter(instance);
    await tick(20);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("queued");
    resolvers.shift()?.();
    await tick(120);
    resolvers.shift()?.();
    await tick(40);
    expect(seen).toEqual(["first", "queued one"]);
    instance.unmount();
  });
});

describe("features: @-mention picker", () => {
  test("typing `@RE` opens the picker and matches cwd files", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "README.md"), "# hi");
    const instance = renderApp({ cwd: dir });
    await tick();
    await type(instance, "see @RE");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("@-mentions");
    expect(frame).toContain("README.md");
    instance.unmount();
  });

  test("Tab accepts the highlighted candidate and splices it into the buffer", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "docs.md"), "hi");
    const instance = renderApp({ cwd: dir });
    await tick();
    await type(instance, "inline @doc");
    await tick(30);
    instance.stdin.write("\t");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("@docs.md");
    instance.unmount();
  });

  test("no matches → dismissible empty hint", async () => {
    const dir = tmpDir();
    const instance = renderApp({ cwd: dir });
    await tick();
    await type(instance, "@NOPE");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("no matches");
    instance.unmount();
  });
});

describe("features: inline reverse-i-search", () => {
  test("typing filters the match list as the user types", async () => {
    const path = tmpHist();
    appendHistory("draft invoice digest", { path, tenant: "acme" });
    appendHistory("deploy the docs", { path, tenant: "acme" });
    appendHistory("list schedules", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    instance.stdin.write("\x12");
    await tick(30);
    await type(instance, "dep");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("deploy the docs");
    expect(frame).toMatch(/deploy the docs/);
    instance.unmount();
  });

  test("Esc cancels the inline search without changing the buffer", async () => {
    const path = tmpHist();
    appendHistory("draft", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    await type(instance, "keep this");
    instance.stdin.write("\x12");
    await tick(30);
    instance.stdin.write("\x1b");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("reverse-i-search");
    expect(frame).toContain("keep this");
    instance.unmount();
  });

  test("Enter commits the highlighted match into the composer buffer", async () => {
    const path = tmpHist();
    appendHistory("committed", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    instance.stdin.write("\x12");
    await tick(30);
    instance.stdin.write("\r");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("reverse-i-search");
    expect(frame).toContain("committed");
    instance.unmount();
  });
});

const NOW = "2026-01-01T00:00:00.000Z";

interface FakeUpload {
  fid: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

function makeFakeEngine(uploads: FakeUpload[]): EngineClient {
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

describe("features: file-path paste", () => {
  test("pasting an existing image path keeps the path visible and uploads on submit", async () => {
    const dir = tmpDir();
    const imgPath = join(dir, "pic.png");
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const fid = "fid_00000000-0000-0000-0000-000000000001";
    const engineClient = makeFakeEngine([
      { fid, filename: "pic.png", content_type: "image/png", size_bytes: 8 },
    ]);
    const prompts: string[] = [];
    const instance = renderApp({
      cwd: dir,
      engineClient,
      onPrompt: async (text) => {
        prompts.push(text);
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    instance.stdin.write(imgPath);
    await tick(40);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain(imgPath);
    expect(frame).not.toContain(fid);
    expect(frame).not.toContain('"$file"');
    await pressEnter(instance);
    await tick(80);
    expect(prompts[0]).toContain(fid);
    expect(prompts[0]).toContain('"$file"');
    instance.unmount();
  });

  test("pasting a quoted text path with spaces keeps it visible and reads on submit", async () => {
    const dir = tmpDir();
    const pdfPath = join(dir, "invoice draft.md");
    writeFileSync(pdfPath, "# Invoice");
    const fid = "fid_00000000-0000-0000-0000-000000000002";
    const engineClient = makeFakeEngine([
      { fid, filename: "invoice draft.md", content_type: "text/markdown", size_bytes: 9 },
    ]);
    const prompts: string[] = [];
    const instance = renderApp({
      cwd: dir,
      engineClient,
      onPrompt: async (text) => {
        prompts.push(text);
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    instance.stdin.write(`"${pdfPath}"`);
    await tick(40);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain(`"${pdfPath}"`);
    expect(frame).not.toContain(fid);
    await pressEnter(instance);
    await tick(80);
    expect(prompts[0]).toContain("## Local file contents: invoice draft.md");
    expect(prompts[0]).toContain("# Invoice");
    expect(prompts[0]).not.toContain(fid);
    expect(prompts[0]).not.toContain('"$file"');
    instance.unmount();
  });

  test("a missing path-shaped paste remains normal text through submit", async () => {
    const engineClient = makeFakeEngine([]);
    const prompts: string[] = [];
    const instance = renderApp({
      engineClient,
      onPrompt: async (text) => {
        prompts.push(text);
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    instance.stdin.write("/tmp/does-not-exist-report.pdf");
    await tick(40);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("/tmp/does-not-exist-report.pdf");
    expect(frame).not.toContain("uploaded");
    await pressEnter(instance);
    await tick(80);
    expect(prompts[0]).toBe("/tmp/does-not-exist-report.pdf");
    instance.unmount();
  });
});

describe("features: /history built-in", () => {
  test("/history prints the count + file path", async () => {
    const path = tmpHist();
    appendHistory("seed", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    await type(instance, "/history");
    await pressEnter(instance);
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/\/history:\s+\d+\s+prompt/);
    instance.unmount();
  });

  test("/history clear empties the in-memory ring + file", async () => {
    const path = tmpHist();
    appendHistory("zap", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    await type(instance, "/history clear");
    await pressEnter(instance);
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/history: cleared");
    instance.unmount();
  });
});
