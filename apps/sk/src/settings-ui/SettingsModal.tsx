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
  const [innerOwnsEsc, setInnerOwnsEsc] = useState(false);

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
