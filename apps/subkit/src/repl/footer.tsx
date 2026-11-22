import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import { formatTokens } from "../render/format.ts";

export { formatTokens };

interface FooterProps {
  user: string;
  tenant: string | null;
  engineUrl: string;
  sessionId: string | null;
  transcriptMode: "chat" | "inspect";
  connectionState?: "online" | "reconnecting" | "offline" | "unknown";
  connectionReason?: string | null;
  sessionTokens?: number;
  tokensToday?: number | null;
  tokensMonth?: number | null;
  promptTokensLastCall?: number | null;
  turnTokensTotal?: number | null;
  contextCapTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheReadPct?: number | null;
  columns?: number | undefined;
  hintLine?: string | null | undefined;
}

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
  transcriptMode,
  connectionState = "unknown",
  connectionReason,
  sessionTokens = 0,
  tokensToday = null,
  tokensMonth = null,
  promptTokensLastCall = null,
  turnTokensTotal = null,
  contextCapTokens = null,
  cacheReadTokens = null,
  cacheReadPct = null,
  columns = 80,
  hintLine = null,
}) => {
  const theme = useTheme();
  const viewColor = theme.role.assistant;
  const layout = layoutFooterLines({
    user,
    tenant,
    engineUrl,
    sessionId,
    transcriptMode,
    connectionState,
    connectionReason: connectionReason ?? null,
    columns,
  });
  const connChip = renderConnectionBadge(connectionState, connectionReason ?? null, theme, layout);
  const hasAnyUsage =
    sessionTokens > 0 ||
    (tokensToday != null && tokensToday > 0) ||
    (tokensMonth != null && tokensMonth > 0);
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
        <Text color={viewColor} bold>
          ⏵⏵{" "}
        </Text>
        <Text color={viewColor}>{layout.viewLabel}</Text>
        <Text color={theme.severity.dim}>{layout.activitySuffix}</Text>
      </Box>
      {hintLine ? (
        <Box>
          <Text color={theme.severity.dim}> {hintLine}</Text>
        </Box>
      ) : null}
      {hasAnyUsage ? (
        <BudgetLine
          sessionTokens={sessionTokens}
          tokensToday={tokensToday}
          tokensMonth={tokensMonth}
          promptTokensLastCall={promptTokensLastCall}
          turnTokensTotal={turnTokensTotal}
          contextCapTokens={contextCapTokens}
          cacheReadTokens={cacheReadTokens}
          cacheReadPct={cacheReadPct}
          theme={theme}
        />
      ) : null}
    </Box>
  );
};

interface BudgetLineProps {
  sessionTokens: number;
  tokensToday: number | null;
  tokensMonth: number | null;
  promptTokensLastCall: number | null;
  turnTokensTotal: number | null;
  contextCapTokens: number | null;
  cacheReadTokens: number | null;
  cacheReadPct: number | null;
  theme: ReturnType<typeof useTheme>;
}

const BudgetLine: React.FC<BudgetLineProps> = ({
  sessionTokens,
  tokensToday,
  tokensMonth,
  promptTokensLastCall,
  turnTokensTotal,
  contextCapTokens,
  cacheReadTokens,
  cacheReadPct,
  theme,
}) => {
  const monthDisplay = formatTokens(tokensMonth);
  const monthColor = theme.severity.dim;

  const ctxPct =
    promptTokensLastCall != null && contextCapTokens != null && contextCapTokens > 0
      ? Math.min(100, Math.round((promptTokensLastCall / contextCapTokens) * 100))
      : null;
  const ctxColor =
    ctxPct == null
      ? theme.severity.dim
      : ctxPct >= 95
        ? theme.severity.error
        : ctxPct >= 80
          ? theme.severity.warning
          : theme.severity.dim;
  const showCtx = promptTokensLastCall != null && contextCapTokens != null;
  const showTurn = turnTokensTotal != null && turnTokensTotal > 0;

  const showCache = cacheReadPct != null;
  const cacheColor =
    cacheReadPct != null && cacheReadPct >= 50 ? theme.role.assistant : theme.severity.dim;

  return (
    <Box>
      <Text color={theme.severity.dim}> ↘ session </Text>
      <Text color={theme.role.assistant}>{formatTokens(sessionTokens)}</Text>
      <Text color={theme.severity.dim}> · today </Text>
      <Text color={theme.severity.dim}>{formatTokens(tokensToday)}</Text>
      <Text color={theme.severity.dim}> · month </Text>
      <Text color={monthColor}>{monthDisplay}</Text>
      {showTurn ? (
        <>
          <Text color={theme.severity.dim}> · turn </Text>
          <Text color={theme.severity.dim}>{formatTokens(turnTokensTotal)}</Text>
        </>
      ) : null}
      {showCtx ? (
        <>
          <Text color={theme.severity.dim}> · ctx </Text>
          <Text color={ctxColor}>
            {formatTokens(promptTokensLastCall)}/{formatTokens(contextCapTokens)}
          </Text>
          {ctxPct != null && ctxPct >= 80 ? <Text color={ctxColor}> ({ctxPct}%)</Text> : null}
        </>
      ) : null}
      {showCache ? (
        <>
          <Text color={theme.severity.dim}> · cache </Text>
          <Text color={cacheColor}>{cacheReadPct}%</Text>
          {cacheReadTokens != null && cacheReadTokens > 0 ? (
            <Text color={theme.severity.dim}> ({formatTokens(cacheReadTokens)})</Text>
          ) : null}
        </>
      ) : null}
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
  viewLabel: string;
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

const REASON_TRUNCATION_BUDGET = 37;
const REASON_ELLIPSIS = "…";

function connectionChipWidth(
  state: "online" | "reconnecting" | "offline" | "unknown",
  variant: "none" | "compact" | "full",
  reason: string | null,
): number {
  if (state === "online" || state === "unknown" || variant === "none") return 0;
  const labelLength = state === "offline" ? "● offline".length : "⟳ reconnecting".length;
  const baseWidth = " · ".length + labelLength;
  if (variant === "compact") return baseWidth;
  if (!reason || reason.length === 0) return baseWidth;
  const reasonRendered =
    reason.length > REASON_TRUNCATION_BUDGET + 3
      ? REASON_TRUNCATION_BUDGET + REASON_ELLIPSIS.length
      : reason.length;
  return baseWidth + " · ".length + reasonRendered;
}

export function layoutFooterLines(props: FooterProps): FooterLayout {
  const tenantLabel = props.tenant ?? "(no tenant)";
  const host = engineHost(props.engineUrl);
  const sessionLabel = props.sessionId ? props.sessionId.slice(0, 8) : "new";
  const nextView = props.transcriptMode === "chat" ? "inspect" : "chat";
  const width = Math.max(props.columns ?? 80, 24);
  const reason = props.connectionReason ?? null;
  const hasConnection =
    props.connectionState === "offline" || props.connectionState === "reconnecting";
  const identityVariants = [
    {
      prefix: `${props.user} @ ${tenantLabel} · ${host} · session `,
      highlight: sessionLabel,
      suffix: "",
    },
    {
      prefix: `${props.user} @ ${tenantLabel} · session `,
      highlight: sessionLabel,
      suffix: "",
    },
    {
      prefix: `${tenantLabel} · session `,
      highlight: sessionLabel,
      suffix: "",
    },
    {
      prefix: "session ",
      highlight: sessionLabel,
      suffix: "",
    },
  ] as const satisfies readonly [
    { prefix: string; highlight: string; suffix: string },
    ...Array<{ prefix: string; highlight: string; suffix: string }>,
  ];

  const activityVariants = [
    { viewLabel: props.transcriptMode, suffix: ` · ctrl-o ${nextView}` },
    { viewLabel: props.transcriptMode, suffix: "" },
  ] as const satisfies readonly [
    { viewLabel: string; suffix: string },
    ...Array<{ viewLabel: string; suffix: string }>,
  ];

  const compactChipWidth = hasConnection
    ? connectionChipWidth(props.connectionState ?? "unknown", "compact", reason)
    : 0;
  const identity = pickVariant(identityVariants, (variant) => {
    const identityWidth = variant.prefix.length + variant.highlight.length + variant.suffix.length;
    return identityWidth + compactChipWidth <= width - 2;
  });

  let connectionVariant: "none" | "compact" | "full" = "none";
  if (hasConnection) {
    const identityWidth =
      identity.prefix.length + identity.highlight.length + identity.suffix.length;
    const fullChipWidth = connectionChipWidth(props.connectionState ?? "unknown", "full", reason);
    connectionVariant = reason && identityWidth + fullChipWidth <= width - 2 ? "full" : "compact";
  }

  const activity = pickVariant(
    activityVariants,
    (variant) => variant.viewLabel.length + variant.suffix.length <= width - 4,
  );

  return {
    identityPrefix: identity.prefix,
    identityHighlight: identity.highlight,
    identitySuffix: identity.suffix,
    viewLabel: activity.viewLabel,
    activitySuffix: activity.suffix,
    connectionVariant,
  };
}
