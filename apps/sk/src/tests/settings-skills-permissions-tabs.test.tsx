import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import type { EngineClient } from "../engine-client.ts";
import { ConsentPrompt } from "../repl/components/ConsentPrompt.tsx";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

function makeSkillsClient(
  items: Array<{ id: string; title: string; scope: string; status: string }>,
): {
  client: EngineClient;
  activate: ReturnType<typeof mock>;
  archive: ReturnType<typeof mock>;
} {
  const activate = mock(async () => ({}));
  const archive = mock(async () => ({}));
  const client = {
    skBootstrap: mock(async () => ({
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
    })),
    listMcpTools: mock(async () => ({ items: [] })),
    listMcpPrompts: mock(async () => ({ items: [] })),
    listMcpResources: mock(async () => ({ items: [] })),
    tailAuditLog: mock(async () => ({ items: [] })),
    listSkills: mock(async () => ({ items })),
    activateSkill: activate,
    archiveSkill: archive,
  } as unknown as EngineClient;
  return { client, activate, archive };
}

async function navigateTo(
  client: EngineClient,
  steps: number,
): Promise<ReturnType<typeof renderInk>> {
  const node = (
    <SettingsModal
      fields={[]}
      pendingRestartKeys={[]}
      overrideKeys={[]}
      client={client}
      onExit={() => {}}
    />
  ) as React.ReactElement;
  const ui = renderInk(node);
  for (let i = 0; i < steps; i++) await ui.press("right");
  return ui;
}

describe("SkillsTab — multi-select toggle (M6)", () => {
  test("renders skill rows with status checkbox", async () => {
    const { client } = makeSkillsClient([
      { id: "s1", title: "draft-workflow", scope: "global", status: "active" },
      { id: "s2", title: "lint-recipe", scope: "global", status: "archived" },
    ]);
    const ui = await navigateTo(client, 3);
    try {
      await ui.waitFor((t) => t.includes("draft-workflow"));
      const txt = ui.text();
      expect(txt).toContain("[x]");
      expect(txt).toContain("draft-workflow");
      expect(txt).toContain("[ ]");
      expect(txt).toContain("lint-recipe");
    } finally {
      ui.unmount();
    }
  });

  test("space toggles a row from active → archived", async () => {
    const { client, archive } = makeSkillsClient([
      { id: "s1", title: "draft-workflow", scope: "global", status: "active" },
    ]);
    const ui = await navigateTo(client, 3);
    try {
      await ui.waitFor((t) => t.includes("draft-workflow"));
      await ui.type(" ");
      await ui.waitFor(() => archive.mock.calls.length > 0, { tries: 50, sleepMs: 5 });
      expect(archive.mock.calls.length).toBe(1);
    } finally {
      ui.unmount();
    }
  });
});

describe("ConsentPrompt (M6)", () => {
  test("'1' invokes onYes", async () => {
    let yes = 0;
    let no = 0;
    const ui = renderInk(
      <ConsentPrompt
        title="Save memory"
        body="Capture this tip for next time?"
        onYes={() => {
          yes++;
        }}
        onNo={() => {
          no++;
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Save memory"));
      await ui.type("1");
      expect(yes).toBe(1);
      expect(no).toBe(0);
    } finally {
      ui.unmount();
    }
  });

  test("'2' invokes onNo", async () => {
    let yes = 0;
    let no = 0;
    const ui = renderInk(
      <ConsentPrompt
        title="Save memory"
        onYes={() => {
          yes++;
        }}
        onNo={() => {
          no++;
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Save memory"));
      await ui.type("2");
      expect(no).toBe(1);
      expect(yes).toBe(0);
    } finally {
      ui.unmount();
    }
  });
});
