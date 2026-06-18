// Setup-banner render test — drives `<InkApp>` end-to-end with a
// stubbed `setupSnapshot` and asserts the one-line banner renders
// (or stays hidden) above the welcome panel based on the snapshot's
// overall status. Mirrors the journey-test rig (`ink-app.test.tsx`)
// for shape so the two suites stay easy to refactor together.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import type { SetupValidationResponse } from "../engine-client.ts";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

const ADMIN: PersonaProbe = { allows: () => true };
const ENDUSER: PersonaProbe = {
  allows: (p: string) =>
    new Set(["conversation:read", "conversation:write", "conversation:list"]).has(p),
};

const histDirs: string[] = [];
function tmpHistory(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-setup-banner-"));
  histDirs.push(d);
  return join(d, "history.jsonl");
}

function defaultProps(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "tenant-alpha",
      engineUrl: "http://localhost:8080",
      profileName: "test",
      probe: ADMIN,
    },
    statusLineConfig: { format: "{persona}", refreshMs: 999_999 },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/ws",
    historyPath: tmpHistory(),
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c0",
    }),
    ...overrides,
  };
}

function emptySection() {
  return {
    title: "",
    status: "ok" as const,
    issues: [],
    recommendations: [],
    values: [],
  };
}

function snapshot(
  overall: "ok" | "warn" | "blocked",
  warnings = 0,
  blockers = 0,
): SetupValidationResponse {
  return {
    overall_status: overall,
    summary_counts: {
      blockers,
      warnings,
      sections_blocked: blockers > 0 ? 1 : 0,
      sections_warn: warnings > 0 ? 1 : 0,
    },
    sections: {
      auth: emptySection(),
      llm: emptySection(),
      datastore: emptySection(),
      storage: emptySection(),
      crypto: emptySection(),
      public_urls: emptySection(),
    },
    issues: [],
    recommendations: [],
  };
}

async function tick(ms = 30): Promise<void> {
  // ink's input parser needs a real macrotask to disambiguate Esc
  // (\x1b) from arrow-key prefixes, so the journey tests already
  // rely on a small tick. Reuse it here so the mounted `<App>`
  // flushes its useEffects before we read the frame.
  // allow-wall-clock: ink keypress decoding requires real ms.
  await new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  cleanup();
  while (histDirs.length > 0) {
    const d = histDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("setup banner — render path", () => {
  test("renders ⚠ Setup line with warning count when overall_status === warn", async () => {
    const instance = render(<InkApp {...defaultProps({ setupSnapshot: snapshot("warn", 2) })} />);
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("⚠ Setup");
    expect(frame).toContain("2 warnings");
    // Ends with the bare `/setup` slash so it
    // can't be misread as `/setup-for-details` (operator typed
    // `/details` and got an unknown-slash error).
    expect(frame).toContain("Type /setup");
    expect(frame).not.toContain("/setup for details");
    instance.unmount();
  });

  test("renders ✗ Setup line with blocker count when overall_status === blocked", async () => {
    const instance = render(
      <InkApp {...defaultProps({ setupSnapshot: snapshot("blocked", 0, 1) })} />,
    );
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("✗ Setup");
    expect(frame).toContain("1 blocking issue");
    expect(frame).toContain("Type /setup");
    expect(frame).not.toContain("/setup to resolve");
    instance.unmount();
  });

  test("renders no banner when overall_status === ok", async () => {
    const instance = render(<InkApp {...defaultProps({ setupSnapshot: snapshot("ok") })} />);
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("⚠ Setup");
    expect(frame).not.toContain("✗ Setup");
    instance.unmount();
  });

  test("renders no banner when setupSnapshot is null (snapshot not fetched yet)", async () => {
    const instance = render(<InkApp {...defaultProps({ setupSnapshot: null })} />);
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("⚠ Setup");
    expect(frame).not.toContain("✗ Setup");
    instance.unmount();
  });

  test("hides the banner for personas without diagnostics permissions", async () => {
    const instance = render(
      <InkApp
        {...defaultProps({
          setupSnapshot: snapshot("warn", 5),
          persona: {
            label: "enduser",
            tenant: "tenant-alpha",
            engineUrl: "http://localhost:8080",
            profileName: "enduser",
            probe: ENDUSER,
          },
        })}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? "";
    // Endusers can't read /v1/diagnostics, so a banner pointing at
    // /setup would just confuse them. The CLI suppresses it.
    expect(frame).not.toContain("⚠ Setup");
    instance.unmount();
  });

  test("uses singular noun for warning count of 1", async () => {
    const instance = render(<InkApp {...defaultProps({ setupSnapshot: snapshot("warn", 1) })} />);
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("1 warning");
    expect(frame).not.toContain("1 warnings");
    instance.unmount();
  });
});
