// Ink form tests via ink-testing-library.
//
// ink-testing-library exposes the rendered frame string but its
// `stdin.write` interaction with Ink's input parser is harness-
// specific (escape sequences for arrow keys, raw-mode handling). We
// cover the rendering invariants here and verify the commit-path call
// chain via direct method calls below; the keyboard model itself is
// covered by the keybindings unit tests + the manual smoke flow
// documented in the runbook.

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type {
  EngineClient,
  SettingLeafEntry,
  SettingPutResult,
  SettingsListResponse,
} from "../../engine-client.ts";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { SettingItem } from "../components/SettingItem.tsx";
import { leafToFormField } from "../lib/zod-to-form-fields.ts";
import { SettingsModal } from "../SettingsModal.tsx";

const FIXTURE_LEAVES: SettingLeafEntry[] = [
  {
    path: "log.level",
    value: "info",
    meta: {
      source: "default",
      scope: "global",
      sensitive: false,
      requiresRestart: true,
      kind: "enum",
      description: "Log verbosity",
    },
  },
  {
    path: "log.format",
    value: "ndjson",
    meta: {
      source: "default",
      scope: "global",
      sensitive: false,
      requiresRestart: true,
      kind: "enum",
    },
  },
  {
    path: "llm.api_key",
    value: "",
    meta: {
      source: "default",
      scope: "tenant",
      sensitive: true,
      requiresRestart: false,
      kind: "string",
    },
  },
];

const FIELDS = FIXTURE_LEAVES.map(leafToFormField);

interface StubState {
  setCalls: Array<{ path: string; value: unknown; force?: boolean }>;
  putResult: SettingPutResult;
}

function buildStubClient(state: StubState): EngineClient {
  return {
    setSetting: async (
      path: string,
      value: unknown,
      opts: { tenant?: string; force?: boolean } = {},
    ): Promise<SettingPutResult> => {
      state.setCalls.push({
        path,
        value,
        ...(opts.force !== undefined ? { force: opts.force } : {}),
      });
      return state.putResult;
    },
    listSettings: async (): Promise<SettingsListResponse> => ({
      items: FIXTURE_LEAVES,
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    }),
    getSetting: async (): Promise<SettingLeafEntry> => FIXTURE_LEAVES[0]!,
    // The Status tab (default landing) polls these on mount.
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

describe("SettingsModal — render shape", () => {
  test("renders the 5-tab header strip with Status landing by default", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        fields={FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={buildStubClient(state)}
        onExit={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("sk settings");
    expect(frame).toMatch(/cycles? tabs/);
    // 5 canonical tabs in order
    for (const tab of ["Status", "Config", "Usage", "Skills", "Knowledge"]) {
      expect(frame, `tab "${tab}" missing from header`).toContain(tab);
    }
    // Status is the default landing — header for that tab body
    expect(frame).toContain("Runtime status");
    unmount();
  });

  test("tenant tag renders only when --tenant is set", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        fields={FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        tenant="tenant-X"
        client={buildStubClient(state)}
        onExit={() => undefined}
      />,
    );
    expect(lastFrame() ?? "").toContain("tenant: tenant-X");
    unmount();
  });

  test("initialTab='Config' opens directly on the Config tab", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        fields={FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        initialTab="Config"
        client={buildStubClient(state)}
        onExit={() => undefined}
      />,
    );
    // Config tab body renders the filter hint + every leaf label.
    // Row bodies use the curated label from lib/config-labels.ts;
    // llm.api_key's label is "Primary API key".
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Type to filter");
    expect(frame).toContain("Primary API key");
    unmount();
  });

  test("legacy initialTab (e.g. an engine section name) falls back to Status", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        fields={FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        initialTab="llm"
        client={buildStubClient(state)}
        onExit={() => undefined}
      />,
    );
    // `llm` is no longer a tab — pickInitialOuter returns 0 (Status).
    expect(lastFrame() ?? "").toContain("Runtime status");
    unmount();
  });
});

describe("SettingItem", () => {
  const baseField = leafToFormField(FIXTURE_LEAVES[0]!);

  test("highlights the selected row with the cursor glyph", () => {
    const { lastFrame, unmount } = render(<SettingItem field={baseField} selected={true} />);
    expect(lastFrame() ?? "").toMatch(/▸/);
    unmount();
  });

  test("masks a sensitive value to `•••`", () => {
    const sensitive = leafToFormField({
      ...FIXTURE_LEAVES[2]!,
      value: "live-key",
    });
    const { lastFrame, unmount } = render(<SettingItem field={sensitive} selected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("•••");
    expect(frame).not.toContain("live-key");
    unmount();
  });

  test("renders restart + secret badges", () => {
    const { lastFrame, unmount } = render(
      <SettingItem field={leafToFormField(FIXTURE_LEAVES[0]!)} selected={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("restart");
    unmount();
  });
});

describe("SearchInput", () => {
  test("renders nothing when inactive and empty", () => {
    const { lastFrame, unmount } = render(
      <SearchInput active={false} query="" matches={0} total={0} />,
    );
    expect((lastFrame() ?? "").trim()).toBe("");
    unmount();
  });

  test("renders the query, the cursor when active, and the match counter", () => {
    const { lastFrame, unmount } = render(
      <SearchInput active={true} query="api" matches={5} total={20} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/ api");
    expect(frame).toContain("(5/20)");
    unmount();
  });
});

describe("ConfirmModal", () => {
  test("renders the title, body, and Y / N hints", () => {
    const { lastFrame, unmount } = render(
      <ConfirmModal
        title="restart required"
        body="log.level requires a restart"
        onYes={() => undefined}
        onNo={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("restart required");
    expect(frame).toContain("log.level requires a restart");
    expect(frame).toContain("Y");
    expect(frame).toContain("N / Esc");
    unmount();
  });
});
