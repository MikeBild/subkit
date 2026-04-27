// Two-line REPL footer — sits below the bordered composer and keeps the
// persistent chrome intentionally compact:
//
//   line 1: <user> @ <tenant>  ·  <engine-host>  ·  <session>
//   line 2: ⏵⏵ <mode>  ·  <view>            (shift+tab / ctrl-o hints)
//
// Rationale: sk is a workflow-authoring CLI against a multi-tenant
// engine. Users care about "which tenant am I talking to, on which
// engine, in which conversation" — they do not care about their local
// `cwd` or the engine's internal model selection.
//
// Mode labels match subkit's permission semantics, not Claude's brand:
//   ask   → "ask approval"        (engine prompts on tool calls)
//   auto  → "auto-approve on"     (engine auto-confirms tool calls)
//   plan  → "plan mode (read-only)" (engine executes no writes)
//
// The mode glyph color follows `theme.mode.*` so a palette swap
// updates every surface at once.

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import type { PermissionMode } from "../status-line.ts";

export interface FooterProps {
  /** Signed-in user identifier (email, id, or persona label fallback). */
  user: string;
  /** Tenant slug / id — subkit's multi-tenant isolation boundary. */
  tenant: string | null;
  /** Engine base URL — compressed to host:port on render. */
  engineUrl: string;
  /** Current conversation id (post-turn); `null` on a fresh REPL. */
  sessionId: string | null;
  /** Active permission mode — drives line 2 label + glyph color. */
  mode: PermissionMode;
  /** Transcript view indicator shown next to the mode hint. */
  transcriptMode: "chat" | "inspect";
  /** Live engine-connection state from the health pinger. When "offline"
   *  or "reconnecting" the footer shows a red/yellow chip so the user
   *  notices before they hit a mysterious tool failure. */
  connectionState?: "online" | "reconnecting" | "offline" | "unknown";
  /** Short reason attached to non-online states. */
  connectionReason?: string | null;
  /** Terminal width hint for collapse logic. */
  columns?: number | undefined;
}

export const MODE_LABELS: Record<PermissionMode, string> = {
  ask: "ask",
  auto: "auto",
  plan: "plan",
  yolo: "yolo",
};

/** Turn an engine URL into a `host:port` string; falls back to the raw value. */
export function engineHost(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

const FooterImpl: React.FC<FooterProps> = ({
  user,
  tenant,
  engineUrl,
  sessionId,
  mode,
  transcriptMode,
  connectionState = "unknown",
  connectionReason,
  columns = 80,
}) => {
  const theme = useTheme();
  const modeColor = theme.mode[mode];
  const layout = layoutFooterLines({
    user,
    tenant,
    engineUrl,
    sessionId,
    mode,
    transcriptMode,
    connectionState,
    connectionReason: connectionReason ?? null,
    columns,
  });
  const connChip = renderConnectionBadge(connectionState, connectionReason ?? null, theme, layout);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.severity.dim}> </Text>
        <Text color={theme.severity.dim}>{layout.identityPrefix}</Text>
        <Text color={theme.role.assistant}>{layout.identityHighlight}</Text>
        <Text color={theme.severity.dim}>{layout.identitySuffix}</Text>
        {connChip}
      </Box>
      <Box>
        <Text color={theme.severity.dim}> </Text>
        <Text color={modeColor} bold>
          ⏵⏵{" "}
        </Text>
        <Text color={modeColor}>{layout.modeLabel}</Text>
        <Text color={theme.severity.dim}>{layout.activitySuffix}</Text>
      </Box>
    </Box>
  );
};

function renderConnectionBadge(
  state: "online" | "reconnecting" | "offline" | "unknown",
  reason: string | null,
  theme: ReturnType<typeof useTheme>,
  layout: FooterLayout,
): React.ReactNode {
  if (state === "online" || state === "unknown") return null;
  const dot = state === "offline" ? "●" : "⟳";
  const label = state === "offline" ? "offline" : "reconnecting";
  const color = state === "offline" ? theme.severity.error : theme.severity.warning;
  const trimmed =
    layout.connectionVariant === "full" && reason && reason.length > 40
      ? `${reason.slice(0, 37)}…`
      : layout.connectionVariant === "full"
        ? reason
        : null;
  return (
    <>
      <Text color={theme.severity.dim}> · </Text>
      <Text color={color} bold>
        {dot} {label}
      </Text>
      {trimmed ? (
        <>
          <Text color={theme.severity.dim}> · </Text>
          <Text color={theme.severity.dim}>{trimmed}</Text>
        </>
      ) : null}
    </>
  );
}

export const Footer = memo(FooterImpl);

type FooterLayout = {
  identityPrefix: string;
  identityHighlight: string;
  identitySuffix: string;
  modeLabel: string;
  activitySuffix: string;
  connectionVariant: "none" | "compact" | "full";
};

function pickVariant<T>(variants: readonly T[], fits: (variant: T) => boolean): T {
  const first = variants[0];
  if (first === undefined) {
    throw new Error("footer layout requires at least one variant");
  }
  for (const variant of variants) {
    if (fits(variant)) return variant;
  }
  return variants[variants.length - 1] ?? first;
}

export function layoutFooterLines(props: FooterProps): FooterLayout {
  const tenantLabel = props.tenant ?? "(no tenant)";
  const host = engineHost(props.engineUrl);
  const sessionLabel = props.sessionId ? props.sessionId.slice(0, 8) : "new";
  const nextView = props.transcriptMode === "chat" ? "inspect" : "chat";
  const width = Math.max(props.columns ?? 80, 24);
  const hasConnection =
    props.connectionState === "offline" || props.connectionState === "reconnecting";
  const identityVariants = [
    {
      prefix: `${props.user} @ ${tenantLabel} · ${host} · session `,
      highlight: sessionLabel,
      suffix: "",
      connectionVariant: hasConnection ? ("full" as const) : ("none" as const),
    },
    {
      prefix: `${props.user} @ ${tenantLabel} · session `,
      highlight: sessionLabel,
      suffix: "",
      connectionVariant: hasConnection ? ("compact" as const) : ("none" as const),
    },
    {
      prefix: `${tenantLabel} · session `,
      highlight: sessionLabel,
      suffix: "",
      connectionVariant: hasConnection ? ("compact" as const) : ("none" as const),
    },
    {
      prefix: "session ",
      highlight: sessionLabel,
      suffix: "",
      connectionVariant: hasConnection ? ("compact" as const) : ("none" as const),
    },
  ] as const satisfies readonly [
    {
      prefix: string;
      highlight: string;
      suffix: string;
      connectionVariant: "none" | "compact" | "full";
    },
    ...Array<{
      prefix: string;
      highlight: string;
      suffix: string;
      connectionVariant: "none" | "compact" | "full";
    }>,
  ];

  const activityVariants = [
    {
      modeLabel: MODE_LABELS[props.mode],
      suffix: ` · ${props.transcriptMode} · shift+tab mode · ctrl-o ${nextView}`,
    },
    {
      modeLabel: MODE_LABELS[props.mode],
      suffix: ` · ${props.transcriptMode} · ctrl-o ${nextView}`,
    },
    { modeLabel: MODE_LABELS[props.mode], suffix: ` · ${props.transcriptMode}` },
    { modeLabel: MODE_LABELS[props.mode], suffix: "" },
  ] as const satisfies readonly [
    { modeLabel: string; suffix: string },
    ...Array<{ modeLabel: string; suffix: string }>,
  ];

  const identity = pickVariant(identityVariants, (variant) => {
    return variant.prefix.length + variant.highlight.length + variant.suffix.length <= width - 2;
  });
  const activity = pickVariant(
    activityVariants,
    (variant) => variant.modeLabel.length + variant.suffix.length <= width - 4,
  );

  return {
    identityPrefix: identity.prefix,
    identityHighlight: identity.highlight,
    identitySuffix: identity.suffix,
    modeLabel: activity.modeLabel,
    activitySuffix: activity.suffix,
    connectionVariant: identity.connectionVariant,
  };
}
