import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "ink-testing-library";
import { appendHistory } from "../repl/history-store.ts";
import {
  ADMIN,
  dirs,
  framesOf,
  makeFakeEngine,
  pressEnter,
  renderApp,
  stripAnsi,
  tick,
  tmpDir,
  tmpHist,
  type,
} from "./input-features-fixtures.tsx";

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
