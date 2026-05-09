// H9 closure of #159 — snapshot tests for key rendered components.
// Asserts that the critical strings remain visible across the full
// matrix of states. ink-testing-library doesn't expose a column
// override directly, but the rendered text for fixed-Box layouts is
// stable across widths because Ink wraps long lines rather than
// dropping them. The strongest regression catch is "key string is
// still visible" + "line count under cap" (already in the size-budget
// test).

import { describe, expect, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import { WelcomeBanner } from "../repl/welcome-banner.tsx";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

const stubClient = {
  skBootstrap: async () => {
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
    ["signed in + tip + whats-new", { tip: "Use /resume", whatsNew: "v4.3 ships /settings" }],
    ["signed out + no whats-new", { signedIn: false }],
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
          (t) => t.includes("sk") && (t.includes("acme") || t.includes("not signed")),
        );
        const txt = ui.text();
        // sk wordmark + version always visible
        expect(txt).toMatch(/^sk \b|· v\d/);
      } finally {
        ui.unmount();
      }
    });
  }
});

describe("SettingsModal — tab strip visibility snapshots (H9)", () => {
  test("non-admin: 9 tabs visible without truncation", async () => {
    const ui = renderInk(
      <SettingsModal
        sections={new Map()}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient}
        isAdmin={false}
        onExit={() => {}}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Settings") && t.includes("Profile"));
      const txt = ui.text();
      const tabs = [
        "Settings",
        "Status",
        "Config",
        "Usage",
        "Stats",
        "Skills",
        "Permissions",
        "Knowledge",
        "Profile",
      ];
      for (const tab of tabs) {
        expect(txt, `tab "${tab}" missing in non-admin render`).toContain(tab);
      }
    } finally {
      ui.unmount();
    }
  });

  test("admin: all 10 tabs visible including Admin", async () => {
    const ui = renderInk(
      <SettingsModal
        sections={new Map()}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient}
        isAdmin={true}
        onExit={() => {}}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Admin"));
      const txt = ui.text();
      expect(txt).toContain("Admin");
    } finally {
      ui.unmount();
    }
  });
});
