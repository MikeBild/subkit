// Settings palette — outer 10-tab shell. The original per-engine-section
// view is preserved in tabs/SettingsTab.tsx; the other nine tabs are
// stubs filled in by M3–M8 of #159.
//
// Esc semantics (two-step):
//   1. If the active tab has its inner search active, the inner tab's
//      Esc handler fires first (clears search). Outer Esc is suppressed
//      until the next keystroke.
//   2. Otherwise, outer Esc closes the modal.
//
// Outer tab navigation: leftarrow / rightarrow OR `[` / `]`. Inner
// engine-section sub-tabs (within the Settings tab) keep tab/shift+tab.
//
// Admin tab visibility: hidden unless `isAdmin === true`. Server still
// enforces; the gate is purely UX.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { EngineClient } from "../engine-client.ts";
import type { FormField } from "./lib/zod-to-form-fields.ts";
import { AdminTab } from "./tabs/AdminTab.tsx";
import { ConfigTab } from "./tabs/ConfigTab.tsx";
import { KnowledgeTab } from "./tabs/KnowledgeTab.tsx";
import { PermissionsTab } from "./tabs/PermissionsTab.tsx";
import { ProfileTab } from "./tabs/ProfileTab.tsx";
import { SettingsTab } from "./tabs/SettingsTab.tsx";
import { SkillsTab } from "./tabs/SkillsTab.tsx";
import { StatsTab } from "./tabs/StatsTab.tsx";
import { StatusTab } from "./tabs/StatusTab.tsx";
import { UsageTab } from "./tabs/UsageTab.tsx";

// S5 of PR #161 review — single source of truth for the tab list.
// `OuterTabName` is derived from `ALL_TABS` via `(typeof ALL_TABS)[number]`
// so future additions only touch the array literal, not a parallel
// string-union.
const ALL_TABS = [
  "Settings",
  "Status",
  "Config",
  "Usage",
  "Stats",
  "Skills",
  "Permissions",
  "Knowledge",
  "Profile",
  "Admin",
] as const;
export type OuterTabName = (typeof ALL_TABS)[number];

interface Props {
  sections: Map<string, FormField[]>;
  pendingRestartKeys: string[];
  overrideKeys: string[];
  tenant?: string;
  initialTab?: string;
  client: EngineClient;
  onExit: (code: number) => void;
  isAdmin?: boolean;
  /**
   * Optional REPL-state props — when /settings is opened from the
   * sk REPL, the host passes these so the Status tab renders real
   * values instead of "—". The `sk settings` standalone CLI doesn't
   * supply them; StatusTab still works by falling back to "—".
   */
  sessionId?: string | null | undefined;
  sessionTitle?: string | null | undefined;
  permissionMode?: "ask" | "auto" | "plan" | "yolo" | undefined;
  sessionTokens?: number | null | undefined;
  weekTokens?: number | null | undefined;
  /** Optional Profile-tab action sink (G7 closure of #159 M7). */
  onProfileAction?: (action: import("./tabs/ProfileTab.tsx").ProfileAction) => void;
}

function visibleTabs(isAdmin: boolean): readonly OuterTabName[] {
  return isAdmin ? ALL_TABS : ALL_TABS.filter((t) => t !== "Admin");
}

function pickInitialOuter(initialTab: string | undefined, tabs: readonly OuterTabName[]): number {
  if (!initialTab) return 0;
  // Match outer tab name exactly first; otherwise default to Settings (idx 0)
  // so a legacy `--tab <engine-section>` argument still reaches the
  // engine-section view.
  const idx = tabs.findIndex((t) => t.toLowerCase() === initialTab.toLowerCase());
  return idx >= 0 ? idx : 0;
}

export const SettingsModal: React.FC<Props> = ({
  sections,
  pendingRestartKeys,
  overrideKeys,
  tenant,
  initialTab,
  client,
  onExit,
  isAdmin = false,
  sessionId,
  sessionTitle,
  permissionMode,
  sessionTokens,
  weekTokens,
  onProfileAction,
}) => {
  const tabs = visibleTabs(isAdmin);
  const [outerIdx, setOuterIdx] = useState(() => pickInitialOuter(initialTab, tabs));
  // The inner Settings tab reports whether its search box is active so
  // we can implement two-step Esc at the outer layer.
  const [innerSearchActive, setInnerSearchActive] = useState(false);

  // The legacy `--tab` argument might name an engine section (e.g. "llm").
  // When the outer pick is "Settings" (default) we forward that string to
  // SettingsTab so the inner section navigation lands on the right one.
  const innerInitialTab =
    tabs[outerIdx] === "Settings" && initialTab
      ? !ALL_TABS.some((t) => t.toLowerCase() === initialTab.toLowerCase())
        ? initialTab
        : undefined
      : undefined;

  useInput((input, key) => {
    // When the active tab is Settings AND its inner search is active,
    // surrender Esc to that tab — it will clear the query and reset
    // innerSearchActive on next render. Outer Esc resumes once cleared.
    if (key.escape) {
      // Tab-agnostic two-step Esc: any inner tab that reports search
      // activity (Settings or Config today) gets first crack at Esc to
      // clear its filter. The next Esc lands on the outer modal.
      if (innerSearchActive) return;
      onExit(0);
      return;
    }
    if (key.leftArrow || input === "[") {
      setOuterIdx((i) => (i - 1 + tabs.length) % tabs.length);
      return;
    }
    if (key.rightArrow || input === "]") {
      setOuterIdx((i) => (i + 1) % tabs.length);
      return;
    }
  });

  const active = tabs[outerIdx] ?? "Settings";

  const headerStrip = (
    <Box>
      {tabs.map((t, i) => (
        <Text key={t} color={i === outerIdx ? "cyan" : "gray"} bold={i === outerIdx}>
          {`${t}${i === tabs.length - 1 ? "" : "  "}`}
        </Text>
      ))}
    </Box>
  );

  const tabBody = (() => {
    switch (active) {
      case "Settings": {
        const props: React.ComponentProps<typeof SettingsTab> = {
          sections,
          pendingRestartKeys,
          overrideKeys,
          client,
          onSearchActiveChange: setInnerSearchActive,
        };
        if (tenant !== undefined) props.tenant = tenant;
        if (innerInitialTab !== undefined) props.initialTab = innerInitialTab;
        return <SettingsTab {...props} />;
      }
      case "Status": {
        const allFields = [...sections.values()].flat();
        return (
          <StatusTab
            client={client}
            fields={allFields}
            pendingRestartKeys={pendingRestartKeys}
            overrideKeys={overrideKeys}
            sessionId={sessionId ?? null}
            sessionTitle={sessionTitle ?? null}
            permissionMode={permissionMode ?? null}
            sessionTokens={sessionTokens ?? null}
            weekTokens={weekTokens ?? null}
          />
        );
      }
      case "Config": {
        const allFields = [...sections.values()].flat();
        const props: React.ComponentProps<typeof ConfigTab> = {
          fields: allFields,
          client,
          onSearchActiveChange: setInnerSearchActive,
        };
        if (tenant !== undefined) props.tenant = tenant;
        return <ConfigTab {...props} />;
      }
      case "Usage":
        return <UsageTab client={client} />;
      case "Stats":
        return <StatsTab client={client} />;
      case "Skills":
        return <SkillsTab client={client} onSearchActiveChange={setInnerSearchActive} />;
      case "Permissions": {
        const props: React.ComponentProps<typeof PermissionsTab> = { client };
        if (tenant !== undefined) props.tenant = tenant;
        return <PermissionsTab {...props} />;
      }
      case "Knowledge":
        return <KnowledgeTab client={client} onSearchActiveChange={setInnerSearchActive} />;
      case "Profile": {
        const props: React.ComponentProps<typeof ProfileTab> = { client };
        if (onProfileAction) props.onAction = onProfileAction;
        return <ProfileTab {...props} />;
      }
      case "Admin":
        return <AdminTab client={client} />;
      default:
        return null;
    }
  })();

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>sk settings</Text>
        {tenant ? <Text color="yellow"> (tenant: {tenant})</Text> : null}
        <Text color="gray"> · ←/→ or [/] cycles tabs · Esc closes</Text>
      </Box>
      {headerStrip}
      <Box marginTop={1}>{tabBody}</Box>
    </Box>
  );
};
