// Settings palette outer-tab keynav test (M2 of #159).
// Asserts:
//   * the 10-tab strip renders
//   * leftarrow / rightarrow cycles tabs
//   * `[` / `]` cycles tabs
//   * Esc closes the modal (calls onExit)
//   * the Admin tab is hidden when isAdmin=false and visible when true
//   * each non-Settings tab mounts its placeholder when activated.

import { describe, expect, test } from "bun:test";
import type React from "react";
import type { EngineClient } from "../engine-client.ts";
import type { FormField } from "../settings-ui/lib/zod-to-form-fields.ts";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

// Minimal client stub — SettingsModal forwards it to every tab,
// several of which call list-* methods on mount. We provide empty-list
// no-ops so the render tree doesn't unwind.
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

function makeSections(): Map<string, FormField[]> {
  const sections = new Map<string, FormField[]>();
  sections.set("llm", [
    {
      path: "llm.model",
      kind: "text",
      value: "claude-opus-4-7",
      scope: "global",
      sensitive: false,
      requiresRestart: false,
      source: "global",
      description: "active model",
    },
  ]);
  return sections;
}

function renderModal(props: {
  isAdmin?: boolean;
  initialTab?: string;
  onExit?: (code: number) => void;
}): ReturnType<typeof renderInk> {
  const onExit = props.onExit ?? (() => {});
  const modalProps: React.ComponentProps<typeof SettingsModal> = {
    sections: makeSections(),
    pendingRestartKeys: [],
    overrideKeys: [],
    client: stubClient,
    isAdmin: props.isAdmin ?? false,
    onExit,
  };
  if (props.initialTab !== undefined) modalProps.initialTab = props.initialTab;
  const node = <SettingsModal {...modalProps} />;
  return renderInk(node);
}

describe("SettingsModal — outer 10-tab palette (M2)", () => {
  test("renders the 9-tab strip when isAdmin=false (Admin hidden)", async () => {
    const ui = renderModal({ isAdmin: false });
    try {
      await ui.waitFor((t) => t.includes("Settings") && t.includes("Profile"));
      const txt = ui.text();
      expect(txt).toContain("Settings");
      expect(txt).toContain("Status");
      expect(txt).toContain("Config");
      expect(txt).toContain("Usage");
      expect(txt).toContain("Stats");
      expect(txt).toContain("Skills");
      expect(txt).toContain("Permissions");
      expect(txt).toContain("Knowledge");
      expect(txt).toContain("Profile");
      expect(txt).not.toContain("Admin");
    } finally {
      ui.unmount();
    }
  });

  test("renders the 10-tab strip when isAdmin=true (Admin visible)", async () => {
    const ui = renderModal({ isAdmin: true });
    try {
      await ui.waitFor((t) => t.includes("Admin"));
      expect(ui.text()).toContain("Admin");
    } finally {
      ui.unmount();
    }
  });

  test("rightarrow advances to Status tab and mounts its body", async () => {
    const ui = renderModal({ isAdmin: false });
    try {
      await ui.waitFor((t) => t.includes("Settings"));
      await ui.press("right");
      await ui.waitFor((t) => t.includes("Runtime status") || t.includes("loading"));
    } finally {
      ui.unmount();
    }
  });

  test("`]` also cycles forward", async () => {
    const ui = renderModal({ isAdmin: false });
    try {
      await ui.waitFor((t) => t.includes("Settings"));
      await ui.type("]");
      await ui.waitFor((t) => t.includes("Runtime status") || t.includes("loading"));
    } finally {
      ui.unmount();
    }
  });

  test("leftarrow from index 0 wraps to the last visible tab", async () => {
    const ui = renderModal({ isAdmin: false });
    try {
      await ui.waitFor((t) => t.includes("Settings"));
      await ui.press("left");
      // Last non-admin tab is Profile (idx 8 of 9). Profile renders its
      // identity card, a loading state, or — when the test stub doesn't
      // expose skBootstrap — a graceful "failed to load identity" row.
      await ui.waitFor(
        (t) =>
          /Profile/.test(t) &&
          (t.includes("loading") || t.includes("email") || t.includes("failed to load")),
      );
    } finally {
      ui.unmount();
    }
  });

  test("Esc invokes onExit(0)", async () => {
    let exitCode: number | undefined;
    const ui = renderModal({
      isAdmin: false,
      onExit: (c) => {
        exitCode = c;
      },
    });
    try {
      await ui.waitFor((t) => t.includes("Settings"));
      // Ink debounces ESC to disambiguate from escape sequences; wall-clock
      // sleepMs lets the disambiguation timer fire.
      await ui.press("esc");
      await ui.waitFor(() => exitCode !== undefined, { tries: 50, sleepMs: 10 });
      expect(exitCode).toBe(0);
    } finally {
      ui.unmount();
    }
  });

  test("cycles through all 10 tabs when isAdmin=true and reaches Admin", async () => {
    const ui = renderModal({ isAdmin: true });
    try {
      await ui.waitFor((t) => t.includes("Settings"));
      // Admin is index 9 (0-Settings,1-Status,2-Config,3-Usage,4-Stats,
      // 5-Skills,6-Permissions,7-Knowledge,8-Profile,9-Admin).
      for (let i = 0; i < 9; i++) await ui.press("right");
      // Admin tab content: outer "Admin" header + sub-tab strip listing
      // RBAC and API Keys. The stub client doesn't expose listRoles etc.,
      // so the inner sub-tab body may surface an error — but the outer
      // strip should always render.
      await ui.waitFor((t) => t.includes("Admin") && t.includes("API Keys"));
    } finally {
      ui.unmount();
    }
  });
});
