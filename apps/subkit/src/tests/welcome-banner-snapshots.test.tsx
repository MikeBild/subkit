import { describe, expect, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import { WelcomeBanner } from "../repl/welcome-banner.tsx";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

const stubClient = {
  subkitBootstrap: async () => {
    throw new Error("stub");
  },
  listMcpTools: async () => ({ items: [] }),
  listMcpPrompts: async () => ({ items: [] }),
  listMcpResources: async () => ({ items: [] }),
  tailAuditLog: async () => ({ items: [] }),
  listSkills: async () => ({ items: [] }),
  listKnowledgeSources: async () => ({ items: [] }),
  listApiKeys: async () => ({ items: [] }),
  listPortalTokens: async () => ({ items: [] }),
  listRoles: async () => ({ items: [] }),
  listSubscriptions: async () => ({ items: [] }),
  listSystemAccounts: async () => ({ items: [] }),
  listHooksInbound: async () => ({ items: [] }),
  listNotificationChannels: async () => ({ items: [] }),
} as unknown as EngineClient;

describe("WelcomeBanner — visibility snapshots (H9)", () => {
  for (const [name, props] of [
    ["signed in + tip", { tip: "Use /resume" }],
    ["signed out", { signedIn: false }],
    ["signed in + target connector", { targetKind: "connector" as const, targetName: "stripe" }],
    [
      "signed in + workflow target + production env",
      {
        targetKind: "workflow" as const,
        targetName: "incident-runbook",
        environment: "production",
      },
    ],
    ["compact mode", { compact: true }],
  ] as const) {
    test(`${name} — key strings visible`, async () => {
      const ui = renderInk(
        <WelcomeBanner
          persona="alice"
          tenant="acme"
          engineUrl="http://localhost:3000"
          {...props}
        />,
      );
      try {
        await ui.waitFor(
          (t) => t.includes("subkit") && (t.includes("acme") || t.includes("not signed")),
        );
        const txt = ui.text();
        expect(txt).toMatch(/^subkit \b|· v\d/);
      } finally {
        ui.unmount();
      }
    });
  }
});

describe("SettingsModal — tab strip visibility snapshots (H9)", () => {
  test("5 canonical tabs visible without truncation", async () => {
    const ui = renderInk(
      <SettingsModal
        fields={[]}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient}
        onExit={() => {}}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Status") && t.includes("Knowledge"));
      const txt = ui.text();
      const tabs = ["Status", "Config", "Usage", "Skills", "Knowledge"];
      for (const tab of tabs) {
        expect(txt, `tab "${tab}" missing in tab strip`).toContain(tab);
      }
    } finally {
      ui.unmount();
    }
  });

  test("operator surfaces (Permissions / Profile / Admin) are NOT inside /settings", async () => {
    const ui = renderInk(
      <SettingsModal
        fields={[]}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient}
        onExit={() => {}}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Status"));
      const txt = ui.text();
      expect(txt).not.toMatch(/\bPermissions\b/);
      expect(txt).not.toMatch(/\bProfile\b/);
      expect(txt).not.toMatch(/\bAdmin\b/);
      expect(txt).not.toMatch(/\bStats\b/);
      expect(txt).not.toMatch(/^Settings\s/m);
    } finally {
      ui.unmount();
    }
  });
});
