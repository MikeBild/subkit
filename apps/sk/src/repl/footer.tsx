// Three-line REPL footer — sits below the bordered composer and keeps
// the persistent chrome intentionally compact:
//
//   line 1: <user> @ <tenant>  ·  <engine-host>  ·  <session>
//   line 2: ⏵⏵ <mode>  ·  <view>            (shift+tab / ctrl-o hints)
//   line 3: ↘ session <N>  ·  today <N>  ·  month <N> / <budget>
//
// Line 3 is suppressed when the operator hasn't fired any turns yet
// (every counter is zero) so a fresh REPL doesn't render a row of
// zeroes. Otherwise it's always visible — operators consistently
// asked for budget transparency without having to leave the REPL.
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
import type { PermissionMode } from "./status-line/render.ts";

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
  /** Cumulative tokens across every turn in the current conversation
   *  (CLI-side accumulator over `usage.turn_tokens`). */
  sessionTokens?: number;
  /** Sum of total_tokens since UTC midnight (engine `/v1/status`). */
  tokensToday?: number | null;
  /** Sum of total_tokens since the start of the current month. */
  tokensMonth?: number | null;
  /** Effective monthly budget; null = unlimited. */
  monthlyBudget?: number | null;
  /** Last turn's prompt size in tokens. Drives the `ctx N/M` gauge. */
  lastTurnPromptTokens?: number | null;
  /** Effective per-prompt context cap for the active model — denominator
   *  of the `ctx N/M` gauge. When null the gauge is hidden because we
   *  cannot tell the operator how close they are to the ceiling. */
  contextCapTokens?: number | null;
  /** Terminal width hint for collapse logic. */
  columns?: number | undefined;
}

/** Compact 1.2k / 4.8M formatting for the budget line. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
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
  sessionTokens = 0,
  tokensToday = null,
  tokensMonth = null,
  monthlyBudget = null,
  lastTurnPromptTokens = null,
  contextCapTokens = null,
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
  // Hide the budget line entirely on a fresh REPL (no turns fired,
  // no engine snapshot yet). Show it the moment any counter has a
  // real value — operators always want budget transparency once
  // they've started spending tokens.
  const hasAnyUsage =
    sessionTokens > 0 ||
    (tokensToday != null && tokensToday > 0) ||
    (tokensMonth != null && tokensMonth > 0) ||
    (monthlyBudget != null && monthlyBudget > 0);
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
      {hasAnyUsage ? (
        <BudgetLine
          sessionTokens={sessionTokens}
          tokensToday={tokensToday}
          tokensMonth={tokensMonth}
          monthlyBudget={monthlyBudget}
          lastTurnPromptTokens={lastTurnPromptTokens}
          contextCapTokens={contextCapTokens}
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
  monthlyBudget: number | null;
  lastTurnPromptTokens: number | null;
  contextCapTokens: number | null;
  theme: ReturnType<typeof useTheme>;
}

const BudgetLine: React.FC<BudgetLineProps> = ({
  sessionTokens,
  tokensToday,
  tokensMonth,
  monthlyBudget,
  lastTurnPromptTokens,
  contextCapTokens,
  theme,
}) => {
  const monthDisplay =
    monthlyBudget != null && monthlyBudget > 0
      ? `${formatTokens(tokensMonth)} / ${formatTokens(monthlyBudget)}`
      : formatTokens(tokensMonth);
  const pct =
    monthlyBudget != null && monthlyBudget > 0 && tokensMonth != null
      ? Math.min(100, Math.round((tokensMonth / monthlyBudget) * 100))
      : null;
  // Color the month chip by usage: green <60%, yellow 60–90%, red >90%.
  // Without a budget the chip stays dim (informational only).
  const monthColor =
    pct == null
      ? theme.severity.dim
      : pct >= 90
        ? theme.severity.error
        : pct >= 60
          ? theme.severity.warning
          : theme.severity.dim;

  // Per-turn context-window gauge. Renders only when the engine sent
  // both the last turn's prompt size and the active model's effective
  // cap (so we can compute a meaningful ratio). Color follows the same
  // green→yellow→red gradient as the monthly chip but at tighter
  // thresholds — the model rejects at 100%, so 80% is the warning line
  // and 95% is the alarm line.
  const ctxPct =
    lastTurnPromptTokens != null && contextCapTokens != null && contextCapTokens > 0
      ? Math.min(100, Math.round((lastTurnPromptTokens / contextCapTokens) * 100))
      : null;
  const ctxColor =
    ctxPct == null
      ? theme.severity.dim
      : ctxPct >= 95
        ? theme.severity.error
        : ctxPct >= 80
          ? theme.severity.warning
          : theme.severity.dim;
  const showCtx = lastTurnPromptTokens != null && contextCapTokens != null;

  return (
    <Box>
      <Text color={theme.severity.dim}> ↘ session </Text>
      <Text color={theme.role.assistant}>{formatTokens(sessionTokens)}</Text>
      <Text color={theme.severity.dim}> · today </Text>
      <Text color={theme.severity.dim}>{formatTokens(tokensToday)}</Text>
      <Text color={theme.severity.dim}> · month </Text>
      <Text color={monthColor}>{monthDisplay}</Text>
      {pct != null ? <Text color={monthColor}> ({pct}%)</Text> : null}
      {showCtx ? (
        <>
          <Text color={theme.severity.dim}> · ctx </Text>
          <Text color={ctxColor}>
            {formatTokens(lastTurnPromptTokens)}/{formatTokens(contextCapTokens)}
          </Text>
          {ctxPct != null && ctxPct >= 80 ? <Text color={ctxColor}> ({ctxPct}%)</Text> : null}
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

/**
 * Render-width estimate for the inline connection chip. Mirrors the
 * branches in `renderConnectionBadge` exactly so the layout planner
 * never picks an identity variant that would collide with the chip
 * and force a mid-word wrap (the bug surfaced in session f00b8d1c
 * at 101 cols with a 50-char reason).
 *
 * For "compact" the chip is just " · ⟳ reconnecting" / " · ● offline".
 * For "full" we add " · <truncated_reason>" using the SAME 37+ellipsis
 * truncation rule that the badge applies, so the math matches reality.
 */
const REASON_TRUNCATION_BUDGET = 37;
const REASON_ELLIPSIS = "…";

function connectionChipWidth(
  state: "online" | "reconnecting" | "offline" | "unknown",
  variant: "none" | "compact" | "full",
  reason: string | null,
): number {
  if (state === "online" || state === "unknown" || variant === "none") return 0;
  // " · " separator + label
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
  // Identity variants are now decoupled from connection variant. The
  // planner picks identity first (largest fit assuming a COMPACT chip
  // — the floor every degraded state still gets), then upgrades the
  // chip to FULL only if there's slack for the truncated reason.
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

  // Identity must fit with at least the COMPACT chip — that's the
  // floor we'll render in any degraded connection state.
  const compactChipWidth = hasConnection
    ? connectionChipWidth(props.connectionState ?? "unknown", "compact", reason)
    : 0;
  const identity = pickVariant(identityVariants, (variant) => {
    const identityWidth = variant.prefix.length + variant.highlight.length + variant.suffix.length;
    return identityWidth + compactChipWidth <= width - 2;
  });

  // Now decide whether we have room to upgrade the chip to FULL (with
  // truncated reason). Prefer "full" so the user sees the reason; fall
  // back to "compact" when the line would otherwise wrap mid-word.
  let connectionVariant: "none" | "compact" | "full" = "none";
  if (hasConnection) {
    const identityWidth =
      identity.prefix.length + identity.highlight.length + identity.suffix.length;
    const fullChipWidth = connectionChipWidth(props.connectionState ?? "unknown", "full", reason);
    connectionVariant = reason && identityWidth + fullChipWidth <= width - 2 ? "full" : "compact";
  }

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
    connectionVariant,
  };
}
