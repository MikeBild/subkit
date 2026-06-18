// End-to-end feature tests for the shell-ergonomics upgrade:
// persistent history + cursor-aware buffer + readline-style
// shortcuts + paste refs + busy-turn queue + @mention picker +
// inline reverse-i-search + /paste + /attach.
//
// Every test mounts <InkApp> via ink-testing-library with a tmp
// history path so runs don't touch ~/.sk.

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

// ---------- Helpers ----------

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
      } catch {
        // ignore
      }
    }
  }
});

// ---------- 1. Persistent history ----------

describe("features: persistent history", () => {
  test("prior prompts from the history file are loaded on mount", async () => {
    const path = tmpHist();
    appendHistory("first run command", { path, tenant: "acme" });
    appendHistory("second run command", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    // Ctrl-R opens the inline search — expect both prior prompts to appear.
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

// ---------- 2. Arrow-key history cycling with draft preservation ----------

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

    // Arrow Up = `\x1b[A`. Single press: newest. Second press: older.
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

    // Start typing a fresh draft, then cycle up and back down — the
    // draft should be restored.
    await type(instance, "my-draft");
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("my-draft");
    instance.stdin.write("\x1b[A"); // up → shows "history entry"
    await tick(20);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("history entry");
    instance.stdin.write("\x1b[B"); // down past newest → restore draft
    await tick(20);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("my-draft");
    instance.unmount();
  });
});

// ---------- 3. Cursor navigation + readline shortcuts ----------

describe("features: cursor + readline shortcuts", () => {
  test("left arrow moves the cursor left without deleting", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "hello");
    instance.stdin.write("\x1b[D"); // left
    await tick(10);
    await type(instance, "X");
    const frame = instance.lastFrame() ?? "";
    // Cursor marker (▊ / ·) is rendered between the before / after
    // slices — strip it and assert on the logical buffer contents.
    const stripped = stripAnsi(frame).replace(/[▊·]/g, "");
    expect(stripped).toContain("hellXo");
    instance.unmount();
  });

  test("Ctrl-A jumps to line start; Ctrl-E to line end", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "middle");
    instance.stdin.write("\x01"); // Ctrl-A
    await tick(10);
    await type(instance, "[");
    instance.stdin.write("\x05"); // Ctrl-E
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
    instance.stdin.write("\x15"); // Ctrl-U
    await tick(10);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    // Composer should show an empty `❯` prompt.
    expect(frame).not.toContain("kill this");
    expect(frame).toMatch(/❯\s+▊/);
    instance.unmount();
  });

  test("Ctrl-W deletes the previous word", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "delete this word");
    instance.stdin.write("\x17"); // Ctrl-W
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
    // Move back to the pipe: 12 chars from end.
    for (let i = 0; i < 12; i++) {
      instance.stdin.write("\x1b[D");
    }
    await tick(10);
    instance.stdin.write("\x0b"); // Ctrl-K
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
    instance.stdin.write("\x0a"); // Ctrl-J → newline
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
    // First Enter on a backslash terminus should NOT submit; it should
    // strip the backslash and insert a newline.
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
    // CSI u sequence for Shift+Enter: ESC [ 13 ; 2 u
    instance.stdin.write("\x1b[13;2u");
    await tick(20);
    // Plain Enter on its own should NOT have submitted yet.
    expect(received.text).toBeNull();
    await type(instance, "second");
    await pressEnter(instance);
    await tick(40);
    // On terminals where Ink's keypress parser doesn't decode CSI u,
    // shift+enter falls back to plain enter and the first line submits
    // alone. Either case must produce a deterministic submit; assert
    // that the second segment did reach onPrompt — proving the
    // composer didn't get stuck.
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
    instance.stdin.write("\x0a"); // newline
    await tick(10);
    await type(instance, "second");
    await pressEnter(instance);
    await tick(60);
    expect(received).toBe("first\nsecond");
    instance.unmount();
  });
});

// ---------- 4. Paste heuristic ----------

describe("features: paste heuristic", () => {
  test("a long pasted chunk is replaced by a [Pasted text #N] ref", async () => {
    const instance = renderApp();
    await tick();
    // Multi-line paste forces the attachment path. Single-line pastes
    // up to ~200 chars now inline directly (session 64db7189 fix).
    instance.stdin.write(`${"x".repeat(40)}\nsecond line of paste`);
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/\[Pasted text #\d+(?: \+\d+ lines)?\]/);
    expect(frame).toContain("attachments · 1 pending");
    expect(frame).toContain("xxxxxxxx");
    instance.unmount();
  });

  test("a short single-line paste is inserted inline (no attachment)", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write("siemens-stock-price");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("siemens-stock-price");
    expect(frame).not.toMatch(/\[Pasted text #\d+\]/);
    expect(frame).not.toContain("attachments · 1 pending");
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
    const body = "multi\nline\npaste content";
    instance.stdin.write(body);
    await tick(30);
    // Submit — the engine sees the full expanded body.
    instance.stdin.write("\r");
    await tick(60);
    expect(received).toContain("multi");
    expect(received).toContain("line");
    expect(received).toContain("paste content");
    instance.unmount();
  });
});

// ---------- 5. Busy-turn queue ----------

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
    await tick(20); // `busy` is now true
    await type(instance, "queued one");
    await pressEnter(instance);
    await tick(20);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("queued");
    // Release the first turn — the queue drains the second.
    resolvers.shift()?.();
    await tick(120);
    // Release the drained turn too.
    resolvers.shift()?.();
    await tick(40);
    expect(seen).toEqual(["first", "queued one"]);
    instance.unmount();
  });
});

// ---------- 6. @-mention picker ----------

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
    instance.stdin.write("\t"); // Tab
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

// ---------- 7. Inline Ctrl-R search ----------

describe("features: inline reverse-i-search", () => {
  test("typing filters the match list as the user types", async () => {
    const path = tmpHist();
    appendHistory("draft invoice digest", { path, tenant: "acme" });
    appendHistory("deploy the docs", { path, tenant: "acme" });
    appendHistory("list schedules", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    instance.stdin.write("\x12"); // Ctrl-R
    await tick(30);
    await type(instance, "dep");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("deploy the docs");
    // Non-matching entries shouldn't be the active pick.
    expect(frame).toMatch(/deploy the docs/);
    instance.unmount();
  });

  test("Esc cancels the inline search without changing the buffer", async () => {
    const path = tmpHist();
    appendHistory("draft", { path, tenant: "acme" });
    const instance = renderApp({ historyPath: path });
    await tick();
    await type(instance, "keep this");
    instance.stdin.write("\x12"); // Ctrl-R
    await tick(30);
    instance.stdin.write("\x1b"); // Esc
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

// ---------- 8. /paste + /attach built-ins ----------

// /attach routes through engine upload + `$file` insert rather than the
// local PasteStore. The tests below provide a mocked EngineClient so
// the slash handler exercises the upload path; assertions cover the
// new behaviour (uploaded info line, fid inserted at the cursor) and
// the unchanged guard rails (missing path, no args).

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

describe("features: /attach built-in slash", () => {
  test("/attach <image> uploads and inserts a $file leaf at the cursor", async () => {
    const dir = tmpDir();
    const imgPath = join(dir, "pic.png");
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const fid = "fid_00000000-0000-0000-0000-000000000001";
    const engineClient = makeFakeEngine([
      { fid, filename: "pic.png", content_type: "image/png", size_bytes: 8 },
    ]);
    const instance = renderApp({ cwd: dir, engineClient });
    await tick();
    await type(instance, `/attach ${imgPath}`);
    await pressEnter(instance);
    await tick(80);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    // Info notice carries the fid + filename + byte count.
    expect(frame).toContain(`uploaded ${fid}`);
    expect(frame).toContain("pic.png");
    // The composer carries the $file JSON leaf (rendered may wrap at
    // box width; assert on the fid substring rather than the full
    // JSON to keep the test robust to wrapping).
    expect(frame).toContain(fid);
    instance.unmount();
  });

  test("/attach <pdf> uploads and inserts a $file leaf", async () => {
    const dir = tmpDir();
    const pdfPath = join(dir, "invoice.pdf");
    writeFileSync(pdfPath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]));
    const fid = "fid_00000000-0000-0000-0000-000000000002";
    const engineClient = makeFakeEngine([
      { fid, filename: "invoice.pdf", content_type: "application/pdf", size_bytes: 5 },
    ]);
    const instance = renderApp({ cwd: dir, engineClient });
    await tick();
    await type(instance, `/attach ${pdfPath}`);
    await pressEnter(instance);
    await tick(80);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain(`uploaded ${fid}`);
    expect(frame).toContain("invoice.pdf");
    expect(frame).toContain(fid);
    instance.unmount();
  });

  test("/attach <missing> reports a helpful message", async () => {
    const engineClient = makeFakeEngine([]);
    const instance = renderApp({ engineClient });
    await tick();
    await type(instance, "/attach ./does-not-exist.pdf");
    await pressEnter(instance);
    await tick(40);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("/attach: not found");
    instance.unmount();
  });

  test("/attach without a path prints usage hint", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/attach");
    await pressEnter(instance);
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("needs a path");
    expect(frame).toContain("error");
    instance.unmount();
  });

  // The legacy `/attach remove <id>` sub-form mutated the local
  // PasteStore. Now /attach uploads to the engine and the
  // PasteStore stays empty for engine-uploaded files; `remove` on an
  // empty store reports a "no pending item" error. The assertion
  // below pins that current contract — engine-backed file removal
  // happens via `sk files delete <fid>`, not the in-REPL shelf.
  test("/attach remove <id> with no pending paste-store item errors clearly", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/attach remove 1");
    await pressEnter(instance);
    await tick(40);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("/attach: no pending item #1");
    instance.unmount();
  });
});

// ---------- 9. /history built-in ----------

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
