// Startup needs-attention panel for the `sk` REPL.
//
// The engine computes a deterministic operator health digest (failed
// runs grouped by root cause + tagged by origin, plus self-healing
// fixes awaiting review and leading-indicator risk signals). At REPL
// open we render it as structured, severity-aware chrome *inside Ink* —
// below the welcome box, above the starter actions — never as a faux
// conversation turn. There is no "Reply yes" prose: acting on the digest
// is the injected "guided triage" starter action, which opens a real,
// digest-grounded conversation turn.
//
// This mirrors version-mismatch-banner.tsx (memo'd Box/Text component)
// and reuses the color/label logic of the retired renderDigestBanner,
// expressed as Ink <Text color=...> instead of picocolors.

import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import type { AttentionItem, OperatorHealthDigest } from "../engine-client.ts";
import {
  attentionItemLine,
  FAILURE_ORIGIN_LABEL,
  totalFailureCount,
  unreadAttentionSources,
} from "../lib/operator-digest.ts";

interface NeedsAttentionPanelProps {
  digest: OperatorHealthDigest;
}

const CLASS_COLOR: Record<AttentionItem["class"], string> = {
  stopped: "red",
  failing: "red",
  decide: "cyan",
};

const NeedsAttentionPanelImpl: React.FC<NeedsAttentionPanelProps> = ({ digest }) => {
  const failCount = totalFailureCount(digest);
  const open = digest.patch_candidates.open;
  // The attention list is what the headline counts: every item gets a line,
  // whatever its kind — a connector needing sign-in, a held schedule, the
  // reader's own waiting conversation — not only the kinds the digest details.
  const items = digest.attention.items;
  const unread = unreadAttentionSources(digest);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text>needs attention</Text>
        <Text dimColor>
          {" "}
          · {items.length} item{items.length === 1 ? "" : "s"} · {failCount} failure
          {failCount === 1 ? "" : "s"} (last {digest.window_hours}h)
        </Text>
      </Box>

      {items.map((item) => (
        <Box key={item.id}>
          <Text color={CLASS_COLOR[item.class]}>● </Text>
          <Text>{attentionItemLine(item)}</Text>
        </Box>
      ))}
      {unread.length > 0 ? (
        <Text color="yellow">could not be read: {unread.join(", ")}</Text>
      ) : null}

      {digest.failure_groups.map((g) => {
        // Whether the scheduler ever started one of these runs, not whether it
        // started all of them: one manual retry used to turn this group yellow
        // while the schedule kept failing every hour.
        const isScheduled = g.scheduled_count > 0 && g.resolved_at === null;
        // A cause whose workflow has run clean on its schedule since is not a
        // live incident; it stays listed, because what broke is worth reading,
        // but it stops being red.
        const sev = isScheduled ? "red" : "yellow";
        const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
        const times = g.count === 1 ? "failed once" : `failed ${g.count}×`;
        return (
          <Box key={g.signature} flexDirection="column">
            <Box>
              <Text color={sev}>● </Text>
              <Text dimColor>[{FAILURE_ORIGIN_LABEL[g.origin]}] </Text>
              <Text bold>{label}</Text>
              <Text> — {times}</Text>
            </Box>
            <Box paddingLeft={4}>
              <Text dimColor>{g.cause}</Text>
            </Box>
            {g.resolved_at ? (
              <Box paddingLeft={4}>
                <Text color="green">last ran clean on its schedule {g.resolved_at}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}

      {open > 0 ? (
        <Box flexDirection="column">
          <Text color="cyan">
            {open} self-healing fix{open === 1 ? "" : "es"} awaiting review
          </Text>
          {digest.patch_candidates.items.slice(0, 5).map((p) => {
            const label = p.workflow_name ?? p.workflow_id ?? "(workflow)";
            return (
              <Box key={p.id}>
                <Text color="cyan">{"  • "}</Text>
                <Text bold>{label}</Text>
                <Text dimColor> [{p.classification}]</Text>
                <Text> — {p.summary}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      {digest.risk.length > 0 ? (
        <Box flexDirection="column">
          <Box>
            <Text>Risk signals</Text>
            <Text dimColor> (leading indicators)</Text>
          </Box>
          {digest.risk.map((r, idx) => {
            const color = r.severity === "critical" ? "red" : "yellow";
            return (
              <Box key={`${r.kind}:${r.headline}:${idx}`} flexDirection="column">
                <Box>
                  <Text color={color}>● </Text>
                  <Text>{r.headline}</Text>
                </Box>
                <Box paddingLeft={4}>
                  <Text dimColor>{r.detail}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
};

export const NeedsAttentionPanel = memo(NeedsAttentionPanelImpl);
NeedsAttentionPanel.displayName = "NeedsAttentionPanel";
