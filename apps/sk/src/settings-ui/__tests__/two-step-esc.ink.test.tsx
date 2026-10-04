import { describe, expect, mock, test } from "bun:test";
import type { EngineClient } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import type { FormField } from "../lib/zod-to-form-fields.ts";
import { SettingsModal } from "../SettingsModal.tsx";
import { ConfigTab } from "../tabs/ConfigTab.tsx";
import { KnowledgeTab } from "../tabs/KnowledgeTab.tsx";
import { ProfileTab } from "../tabs/ProfileTab.tsx";
import { SkillsTab } from "../tabs/SkillsTab.tsx";

function fakeClient(overrides: Partial<EngineClient> = {}): EngineClient {
  return {
    listSkills: mock(async () => ({ items: [] })),
    listKnowledgeSources: mock(async () => ({ items: [] })),
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
    setSetting: mock(async () => ({ value: "", requiresRestart: false })),
    ...overrides,
  } as unknown as EngineClient;
}

const TEXT_FIELDS: FormField[] = [
  {
    path: "log.level",
    kind: "text",
    value: "info",
    scope: "global",
    sensitive: false,
    requiresRestart: false,
    source: "default",
    description: "log verbosity",
  },
];

describe("two-step Esc — onInnerEscape contract", () => {
  test("ConfigTab fires onInnerEscape(true) when search activates", async () => {
    const calls: boolean[] = [];
    const ui = renderInk(
      <ConfigTab fields={TEXT_FIELDS} client={fakeClient()} onInnerEscape={(b) => calls.push(b)} />,
    );
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      expect(calls[0]).toBe(false);
      await ui.type("/");
      await ui.waitFor(() => calls.includes(true));
      expect(calls.at(-1)).toBe(true);
      await ui.press("esc");
      await ui.waitFor(() => calls.at(-1) === false, { tries: 50, sleepMs: 10 });
      expect(calls.at(-1)).toBe(false);
    } finally {
      ui.unmount();
    }
  });

  test("ConfigTab fires onInnerEscape(true) when an editor opens", async () => {
    const calls: boolean[] = [];
    const ui = renderInk(
      <ConfigTab fields={TEXT_FIELDS} client={fakeClient()} onInnerEscape={(b) => calls.push(b)} />,
    );
    try {
      await ui.waitFor((t) => t.includes("log.level"));
      expect(calls.at(-1)).toBe(false);
      await ui.press("enter");
      await ui.waitFor(() => calls.at(-1) === true, { tries: 50, sleepMs: 10 });
      expect(calls.at(-1)).toBe(true);
    } finally {
      ui.unmount();
    }
  });

  test("SkillsTab fires onInnerEscape(true) when search activates", async () => {
    const calls: boolean[] = [];
    const ui = renderInk(<SkillsTab client={fakeClient()} onInnerEscape={(b) => calls.push(b)} />);
    try {
      await ui.waitFor((t) => /skills/i.test(t));
      expect(calls.at(-1)).toBe(false);
      await ui.type("/");
      await ui.waitFor(() => calls.at(-1) === true);
      expect(calls.at(-1)).toBe(true);
    } finally {
      ui.unmount();
    }
  });

  test("KnowledgeTab fires onInnerEscape(true) when ingest prompt opens", async () => {
    const calls: boolean[] = [];
    const ui = renderInk(
      <KnowledgeTab
        client={fakeClient({
          listKnowledgeSources: mock(async () => ({ items: [] })),
        } as unknown as Partial<EngineClient>)}
        onInnerEscape={(b) => calls.push(b)}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Knowledge sources"));
      expect(calls.at(-1)).toBe(false);
      await ui.type("i");
      await ui.waitFor(() => calls.at(-1) === true);
      expect(calls.at(-1)).toBe(true);
      await ui.press("esc");
      await ui.waitFor(() => calls.at(-1) === false, { tries: 50, sleepMs: 10 });
      expect(calls.at(-1)).toBe(false);
    } finally {
      ui.unmount();
    }
  });

  test("end-to-end: SettingsModal Config editor closes on first Esc, modal dismisses on second", async () => {
    const exits: number[] = [];
    const ui = renderInk(
      <SettingsModal
        fields={TEXT_FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={fakeClient()}
        initialTab="Config"
        onExit={(c) => exits.push(c)}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.press("enter");
      await ui.waitFor((t) => t.includes("log.level (text)"));
      await ui.press("esc");
      await ui.waitFor((t) => !t.includes("log.level (text)"), { tries: 100, sleepMs: 10 });
      expect(exits.length).toBe(0);
      await ui.press("esc");
      await ui.waitFor(() => exits.length > 0, { tries: 100, sleepMs: 10 });
      expect(exits[0]).toBe(0);
    } finally {
      ui.unmount();
    }
  });

  test("ProfileTab fires onInnerEscape(true) when tenant picker opens", async () => {
    const calls: boolean[] = [];
    const ui = renderInk(<ProfileTab client={fakeClient()} onInnerEscape={(b) => calls.push(b)} />);
    try {
      await ui.waitFor((t) => t.includes("Profile"));
      expect(calls.at(-1)).toBe(false);
      await ui.type("t");
      await ui.waitFor(() => calls.at(-1) === true);
      expect(calls.at(-1)).toBe(true);
      await ui.press("esc");
      await ui.waitFor(() => calls.at(-1) === false, { tries: 50, sleepMs: 10 });
      expect(calls.at(-1)).toBe(false);
    } finally {
      ui.unmount();
    }
  });
});
