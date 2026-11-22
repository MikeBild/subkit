import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "ink-testing-library";
import { appendHistory } from "../repl/history-store.ts";
import {
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
