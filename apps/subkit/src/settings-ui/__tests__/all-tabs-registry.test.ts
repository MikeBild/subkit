import { describe, expect, test } from "bun:test";
import { ALL_TABS, type OuterTabName } from "../SettingsModal.tsx";

describe("SettingsModal — ALL_TABS registry", () => {
  test("exactly five tabs", () => {
    expect(ALL_TABS.length).toBe(5);
  });

  test("ordered exactly: Status, Config, Usage, Skills, Knowledge", () => {
    expect([...ALL_TABS]).toEqual(["Status", "Config", "Usage", "Skills", "Knowledge"]);
  });

  test("Status is the default landing tab (index 0)", () => {
    expect(ALL_TABS[0]).toBe("Status");
  });

  test("OuterTabName excludes moved tab names", () => {
    // OuterTabName. Each `// @ts-expect-error` line will fail the
    // typecheck if the union ever widens again.
    // @ts-expect-error — Settings was the old engine-section tab (deleted)
    const _settings: OuterTabName = "Settings";
    // @ts-expect-error — Stats heatmap merged into Status
    const _stats: OuterTabName = "Stats";
    // @ts-expect-error — the permission-mode picker is gone
    const _permissions: OuterTabName = "Permissions";
    // @ts-expect-error — moved to /profile SinglePane
    const _profile: OuterTabName = "Profile";
    // @ts-expect-error — moved to /admin SinglePane
    const _admin: OuterTabName = "Admin";
    void _settings;
    void _stats;
    void _permissions;
    void _profile;
    void _admin;
  });

  test("every entry in ALL_TABS is assignable to OuterTabName", () => {
    const tabs: OuterTabName[] = [...ALL_TABS];
    expect(tabs).toEqual(["Status", "Config", "Usage", "Skills", "Knowledge"]);
  });
});
