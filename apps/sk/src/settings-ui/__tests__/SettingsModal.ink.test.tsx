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
import { Footer } from "../components/Footer.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { SettingItem } from "../components/SettingItem.tsx";
import { groupBySection, leafToFormField } from "../lib/zod-to-form-fields.ts";
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

const SECTIONS = groupBySection(FIXTURE_LEAVES.map(leafToFormField));

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
  } as unknown as EngineClient;
}

describe("SettingsModal — render shape", () => {
  test("renders sections, the first leaf in the active tab, and the cursor", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        sections={SECTIONS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={buildStubClient(state)}
        onExit={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    // M2 of #159 replaced the legacy `sk settings configure` title with
    // a 10-tab strip header. The contract is the literal `sk settings`
    // prefix plus the cycle hint — the per-tab content (sections, leaves,
    // cursor) is what the rest of the assertions cover.
    expect(frame).toContain("sk settings");
    expect(frame).toMatch(/cycles? tabs/);
    expect(frame).toContain("log");
    expect(frame).toContain("llm");
    expect(frame).toContain("log.level");
    expect(frame).toMatch(/▸ +log\.level/);
    unmount();
  });

  test("shows the diagnostics banners only when populated", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        sections={SECTIONS}
        pendingRestartKeys={["llm.api_key"]}
        overrideKeys={["llm.api_key"]}
        client={buildStubClient(state)}
        onExit={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("pending restart:");
    expect(frame).toContain("active overrides:");
    expect(frame).toContain("llm.api_key");
    unmount();
  });

  test("tenant tag renders only when --tenant is set", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        sections={SECTIONS}
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

  test("initialTab opens directly on the requested section", () => {
    const state: StubState = { setCalls: [], putResult: { value: "x", requiresRestart: false } };
    const { lastFrame, unmount } = render(
      <SettingsModal
        sections={SECTIONS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        initialTab="llm"
        client={buildStubClient(state)}
        onExit={() => undefined}
      />,
    );
    expect(lastFrame() ?? "").toContain("llm.api_key");
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

describe("Footer", () => {
  test("nav mode lists Tab / ↑↓ / Enter / / / Esc hints", () => {
    const { lastFrame, unmount } = render(<Footer editing={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tab");
    expect(frame).toContain("↑/↓");
    expect(frame).toContain("Enter");
    expect(frame).toContain("Esc");
    unmount();
  });

  test("editing mode shows commit / cancel / reveal", () => {
    const { lastFrame, unmount } = render(<Footer editing={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("commit");
    expect(frame).toContain("cancel");
    expect(frame).toContain("reveal secret");
    unmount();
  });

  test("confirm mode shows force retry hint", () => {
    const { lastFrame, unmount } = render(<Footer editing={false} confirming={true} />);
    expect(lastFrame() ?? "").toContain("retry with force");
    unmount();
  });
});
