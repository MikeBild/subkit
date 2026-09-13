// Settings palette — outer 5-tab shell. Status / Config / Usage plus
// subkit's two AI-pipeline surfaces (Skills / Knowledge) at the same depth.
//
// Operator surfaces (`Permissions`, `Profile`, `Admin`) are not tabs
// here — each is its own slash command mounted via SinglePane:
// `/permissions`, `/profile`, `/admin`. The activity heatmap that
// used to live in a `Stats` tab is now embedded in `Status`.
//
// Esc semantics (two-step, `ownsEsc` pattern):
//   1. If the active tab "owns Esc" — i.e. has an inner state that
//      should be cleared first (search, editor, confirm prompt) —
//      that tab fires its own Esc handler and reports the active
//      state through `onInnerEscape`. Outer Esc is suppressed until
//      the next keystroke.
//   2. Otherwise, outer Esc closes the modal.
//
// Outer tab navigation: leftarrow / rightarrow OR `[` / `]`.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";

import type { EngineClient } from "../engine-client.ts";
import type { FormField } from "./lib/zod-to-form-fields.ts";
import { ConfigTab } from "./tabs/ConfigTab.tsx";
import { KnowledgeTab } from "./tabs/KnowledgeTab.tsx";
import { SkillsTab } from "./tabs/SkillsTab.tsx";
import { StatusTab } from "./tabs/StatusTab.tsx";
import { UsageTab } from "./tabs/UsageTab.tsx";

// Single source of truth for the tab list. `OuterTabName` is derived
// from `ALL_TABS` via `(typeof ALL_TABS)[number]` so future additions
// only touch the array literal, not a parallel string-union.
export const ALL_TABS = ["Status", "Config", "Usage", "Skills", "Knowledge"] as const;
export type OuterTabName = (typeof ALL_TABS)[number];

interface Props {
  fields: FormField[];
  pendingRestartKeys: string[];
  overrideKeys: string[];
  tenant?: string;
  initialTab?: string;
  client: EngineClient;
  onExit: (code: number) => void;
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
}

export function pickInitialOuter(
  initialTab: string | undefined,
  tabs: readonly OuterTabName[],
): number {
  if (!initialTab) return 0;
  const idx = tabs.findIndex((t) => t.toLowerCase() === initialTab.toLowerCase());
  // Unknown / legacy names (e.g. "Settings", engine-section names) fall
  // back to Status (index 0) — no error, no shim.
  return idx >= 0 ? idx : 0;
}

export const SettingsModal: React.FC<Props> = ({
  fields,
  pendingRestartKeys,
  overrideKeys,
  tenant,
  initialTab,
  client,
  onExit,
  sessionId,
  sessionTitle,
  permissionMode,
  sessionTokens,
  weekTokens,
}) => {
  const [outerIdx, setOuterIdx] = useState(() => pickInitialOuter(initialTab, ALL_TABS));
  // The active tab reports whether it "owns Esc" — i.e. has any
  // inner state (search, edit, confirm, …) that the next Esc keystroke
  // should clear instead of dismissing the modal. Two-step Esc:
  //   1. inner state cleared by the active tab's own Esc handler
  //   2. outer Esc dismisses the modal
  const [innerOwnsEsc, setInnerOwnsEsc] = useState(false);

  // Tab switch resets the flag — the previous tab unmounts without
  // firing its `(false)` cleanup, and the next tab fires its own
  // initial effect on mount so the new value is authoritative.
  useEffect(() => {
    setInnerOwnsEsc(false);
  }, [outerIdx]);

  useInput((input, key) => {
    if (key.escape) {
      if (innerOwnsEsc) return;
      onExit(0);
      return;
    }
    if (key.leftArrow || input === "[") {
      setOuterIdx((i) => (i - 1 + ALL_TABS.length) % ALL_TABS.length);
      return;
    }
    if (key.rightArrow || input === "]") {
      setOuterIdx((i) => (i + 1) % ALL_TABS.length);
      return;
    }
  });

  const active = ALL_TABS[outerIdx] ?? "Status";

  const headerStrip = (
    <Box>
      {ALL_TABS.map((t, i) => (
        <Text key={t} color={i === outerIdx ? "cyan" : "gray"} bold={i === outerIdx}>
          {`${t}${i === ALL_TABS.length - 1 ? "" : "  "}`}
        </Text>
      ))}
    </Box>
  );

  const tabBody = (() => {
    switch (active) {
      case "Status":
        return (
          <StatusTab
            client={client}
            fields={fields}
            pendingRestartKeys={pendingRestartKeys}
            overrideKeys={overrideKeys}
            sessionId={sessionId ?? null}
            sessionTitle={sessionTitle ?? null}
            permissionMode={permissionMode ?? null}
            sessionTokens={sessionTokens ?? null}
            weekTokens={weekTokens ?? null}
          />
        );
      case "Config": {
        const props: React.ComponentProps<typeof ConfigTab> = {
          fields,
          client,
          onInnerEscape: setInnerOwnsEsc,
        };
        if (tenant !== undefined) props.tenant = tenant;
        return <ConfigTab {...props} />;
      }
      case "Usage":
        return <UsageTab client={client} />;
      case "Skills":
        return <SkillsTab client={client} onInnerEscape={setInnerOwnsEsc} />;
      case "Knowledge":
        return <KnowledgeTab client={client} onInnerEscape={setInnerOwnsEsc} />;
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
