import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { EngineClient } from "../../engine-client.ts";
import { SettingsModal } from "../SettingsModal.tsx";

function stubClient(): EngineClient {
  return {
    listSettings: async () => ({
      items: [],
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    }),
    skBootstrap: async () => ({
      whoami: {
        id: "u1",
        kind: "user" as const,
        tenant_id: "t1",
        tenant_slug: "acme",
        email: "u@a.test",
        role_name: "admin",
        provider: "workforce",
        base_url: "http://localhost:3000",
        scopes: null,
      },
      permissions: [],
      permissions_checked: [],
      tenant: { id: "t1", slug: "acme", display_name: null },
      recent_sessions: [],
      flags: {},
      server_time: "2024-11-14T22:13:20.000Z",
    }),
    listMcpTools: async () => ({ items: [] }),
    listMcpPrompts: async () => ({ items: [] }),
    listMcpResources: async () => ({ items: [] }),
    tailAuditLog: async () => ({ items: [] }),
  } as unknown as EngineClient;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const ANSI_RE = /[][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PRZcf-nqry=><]|\w+)/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

describe("SettingsModal — outer tab strip regression", () => {
  test("only the 5 canonical tabs are present", () => {
    const { lastFrame, unmount } = render(
      <SettingsModal
        fields={[]}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient()}
        onExit={() => undefined}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    try {
      expect(frame).toMatch(/\bStatus\b/);
      expect(frame).toMatch(/\bConfig\b/);
      expect(frame).toMatch(/\bUsage\b/);
      expect(frame).toMatch(/\bSkills\b/);
      expect(frame).toMatch(/\bKnowledge\b/);

      expect(frame).not.toMatch(/\bPermissions\b/);
      expect(frame).not.toMatch(/\bProfile\b/);
      expect(frame).not.toMatch(/\bAdmin\b/);
      expect(frame).not.toMatch(/\bStats\b/);

      const lines = frame.split("\n");
      const stripLine = lines.find((l) => /Status/.test(l) && /Config/.test(l));
      expect(stripLine, "tab-strip line not found").toBeTruthy();
      expect(stripLine).not.toMatch(/\bSettings\b/);
    } finally {
      unmount();
    }
  });
});
