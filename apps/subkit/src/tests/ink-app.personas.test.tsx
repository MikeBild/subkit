import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "ink-testing-library";
import {
  framesOf,
  histDirs,
  PERSONAS,
  pressEnter,
  renderApp,
  stripAnsi,
  tick,
  type,
  waitForFrame,
} from "./ink-app-fixtures.tsx";

let __homeTempDir: string | undefined;

let __originalHome: string | undefined;

beforeAll(() => {
  __homeTempDir = mkdtempSync(join(tmpdir(), "subkit-ink-app-home-"));
  __originalHome = process.env.HOME;
  process.env.HOME = __homeTempDir;
});

afterAll(() => {
  if (__originalHome !== undefined) process.env.HOME = __originalHome;
  else delete process.env.HOME;
  if (__homeTempDir) rmSync(__homeTempDir, { recursive: true, force: true });
});

afterEach(() => {
  cleanup();
  while (histDirs.length > 0) {
    const d = histDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
  if (__homeTempDir) {
    const subkitDir = join(__homeTempDir, ".subkit");
    try {
      rmSync(subkitDir, { recursive: true, force: true });
    } catch {}
  }
});

describe("ink-app: journey 06 — member persona", () => {
  test("AC1: member /help hides /audit (no audit:read)", async () => {
    const instance = renderApp({
      persona: {
        label: "member",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.member,
      },
    });
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("subkit — slash commands");
    expect(frame).toContain("/compact");
    expect(frame).toContain("/skills");
    expect(frame).toContain("/setup");
    expect(frame).not.toContain("/audit");
    instance.unmount();
  });

  test("AC2: member invoking /audit directly gets a permission-denied banner", async () => {
    const instance = renderApp({
      persona: {
        label: "member",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.member,
      },
    });
    await tick();
    await type(instance, "/audit");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/audit requires audit:read");
    instance.unmount();
  });
});

describe("ink-app: journey 07 — enduser persona", () => {
  test("AC1: enduser /help hides /skills, /mcp, /audit, /tenant, /approve", async () => {
    const instance = renderApp({
      persona: {
        label: "enduser",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.enduser,
      },
    });
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    const paneMatches = frame.match(/╭[\s\S]*?╰[^╰]*?╯/g) ?? [];
    const paneBody = paneMatches.at(-1) ?? "";
    expect(paneBody).toContain("/clear");
    expect(paneBody).toContain("/compact");
    expect(paneBody).not.toContain("/skills");
    expect(paneBody).not.toContain("/audit");
    expect(paneBody).not.toContain("/approve");
    instance.unmount();
  });

  test("AC2: enduser invoking /mcp directly is denied", async () => {
    const instance = renderApp({
      persona: {
        label: "enduser",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.enduser,
      },
    });
    await tick();
    await type(instance, "/mcp");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/mcp requires mcp:read");
    instance.unmount();
  });

  test("AC3: enduser does not get a setup startup banner", async () => {
    const instance = renderApp({
      persona: {
        label: "enduser",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.enduser,
      },
      setupSnapshot: {
        overall_status: "blocked",
        summary_counts: {
          blockers: 1,
          warnings: 0,
          sections_blocked: 1,
          sections_warn: 0,
        },
        sections: {
          auth: { title: "Auth", status: "ok", issues: [], recommendations: [], values: [] },
          llm: { title: "LLM", status: "blocked", issues: [], recommendations: [], values: [] },
          datastore: {
            title: "Datastore",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
          storage: {
            title: "Object storage",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
          crypto: { title: "Crypto", status: "ok", issues: [], recommendations: [], values: [] },
          public_urls: {
            title: "Public URLs",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
        },
        issues: [],
        recommendations: [],
      },
    });
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("setup blocked");
    instance.unmount();
  });
});

describe("ink-app: journey 08 — portal-token persona", () => {
  test("AC1: portal persona /help hides /resume (no conversation:list)", async () => {
    const instance = renderApp({
      persona: {
        label: "portal",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.portal,
      },
    });
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/clear");
    expect(frame).toContain("/compact");
    expect(frame).not.toMatch(/\/resume\s+—/);
    expect(frame).not.toMatch(/\/audit\s+—/);
    instance.unmount();
  });

  test("AC2: portal persona invoking /resume directly is denied", async () => {
    const instance = renderApp({
      persona: {
        label: "portal",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.portal,
      },
    });
    await tick();
    await type(instance, "/resume");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/resume requires conversation:list");
    instance.unmount();
  });
});

describe("ink-app: journey 09 — exit flows", () => {
  test("AC1: /exit triggers onExit", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    await type(instance, "/exit");
    await pressEnter(instance);
    expect(exited).toBe(true);
    instance.unmount();
  });

  test("AC2: /quit is an alias for /exit", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    await type(instance, "/quit");
    await pressEnter(instance);
    expect(exited).toBe(true);
    instance.unmount();
  });

  test("AC4: /exit arriving with its Enter in one input chunk triggers onExit", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    instance.stdin.write("/exit\r");
    await tick(40);
    expect(exited).toBe(true);
    instance.unmount();
  });

  test("AC6: /exit arriving as a cooked-mode line with a trailing newline triggers onExit", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    instance.stdin.write("/exit\n");
    await tick(40);
    expect(exited).toBe(true);
    instance.unmount();
  });

  test("AC5: /help arriving with its Enter in one input chunk opens the help pane", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write("/help\r");
    await tick(40);
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("slash commands");
    instance.unmount();
  });

  test("AC3: double Ctrl-C triggers onExit (first press arms the confirm banner)", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    instance.stdin.write("\x03");
    await tick(20);
    expect(exited).toBe(false);
    instance.stdin.write("\x03");
    await tick(30);
    expect(exited).toBe(true);
    instance.unmount();
  });
});

describe("ink-app: journey 10 — onSlash callback dispatch", () => {
  interface SlashCapture {
    current: { name: string; raw: string } | null;
  }

  test("AC1: /status (no required permission) is forwarded to onSlash", async () => {
    const captured: SlashCapture = { current: null };
    const instance = renderApp({
      onSlash: async (name, raw) => {
        captured.current = { name, raw };
        return "status: engine ok, session fresh";
      },
    });
    await tick();
    await type(instance, "/status");
    await pressEnter(instance);
    await tick(30);
    expect(captured.current).not.toBeNull();
    expect(captured.current?.name).toBe("status");
    expect(captured.current?.raw).toBe("/status");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("status: engine ok, session fresh");
    instance.unmount();
  });

  test("AC2: /cost forwarded with the current session context", async () => {
    const captured: SlashCapture = { current: null };
    const instance = renderApp({
      onSlash: async (name, raw) => {
        captured.current = { name, raw };
        return "turn_tokens=42 · remaining=∞";
      },
    });
    await tick();
    await type(instance, "/cost");
    await pressEnter(instance);
    await tick(30);
    expect(captured.current?.name).toBe("cost");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("turn_tokens=42");
    instance.unmount();
  });

  test("AC3: /model <id> forwards with the model argument in the raw line", async () => {
    const captured: SlashCapture = { current: null };
    const instance = renderApp({
      onSlash: async (name, raw) => {
        captured.current = { name, raw };
        return `model switched to ${raw.split(/\s+/)[1] ?? "(missing)"}`;
      },
    });
    await tick();
    await type(instance, "/model anthropic:claude-opus-4-6");
    await pressEnter(instance);
    await tick(30);
    expect(captured.current?.name).toBe("model");
    expect(captured.current?.raw).toContain("anthropic:claude-opus-4-6");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("model switched to anthropic:claude-opus-4-6");
    instance.unmount();
  });

  test("AC4: /actions launcher filters and dispatches a catalog prompt", async () => {
    let submitted = "";
    const instance = renderApp({
      onPrompt: async (prompt) => {
        submitted = prompt;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c0-00000000-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    await type(instance, "/actions");
    await pressEnter(instance);
    await waitForFrame(instance, (f) => stripAnsi(f).includes("actions"));
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("actions");
    await type(instance, "diagnose");
    await waitForFrame(instance, (f) => stripAnsi(f).includes("Repair latest failure"));
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("Repair latest failure");
    await type(instance, "1");
    await waitForFrame(instance, (f) => stripAnsi(f).includes("Diagnose"));
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("Diagnose");
    expect(submitted).toContain("Diagnose the latest failed workflow execution");
    instance.unmount();
  });
});

describe("ink-app: journey 13 — Ctrl-R inline history search", () => {
  test("AC1: Ctrl-R opens the inline reverse-i-search above the composer", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf({ type: "completed", status: "active" }),
        conversationId: "c-hs-1",
      }),
    });
    await tick();
    await type(instance, "first prompt");
    await pressEnter(instance);
    await tick(40);
    await type(instance, "second prompt");
    await pressEnter(instance);
    await tick(40);

    instance.stdin.write("\x12");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("reverse-i-search");
    expect(frame).toMatch(/1 \/ 2/);
    expect(frame).toContain("second prompt");
    instance.unmount();
  });

  test("AC2: Enter in the inline search restores the highlighted prompt", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf({ type: "completed", status: "active" }),
        conversationId: "c-hs-2",
      }),
    });
    await tick();
    await type(instance, "invoice digest draft");
    await pressEnter(instance);
    await tick(40);
    await type(instance, "hubspot workflow");
    await pressEnter(instance);
    await tick(40);

    instance.stdin.write("\x12");
    await tick(40);
    instance.stdin.write("\r");
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("reverse-i-search");
    expect(frame).toContain("hubspot workflow");
    instance.unmount();
  });
});
