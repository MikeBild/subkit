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
import type { OperatorHealthDigest } from "../engine-client.ts";
import { FAILURE_ORIGIN_LABEL, totalFailureCount } from "../lib/operator-digest.ts";

interface NeedsAttentionPanelProps {
  digest: OperatorHealthDigest;
}

const NeedsAttentionPanelImpl: React.FC<NeedsAttentionPanelProps> = ({ digest }) => {
  const failCount = totalFailureCount(digest);
  const pending = digest.patch_candidates.pending;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text>needs attention</Text>
        <Text dimColor>
          {" "}
          · {failCount} failure{failCount === 1 ? "" : "s"} (last {digest.window_hours}h)
        </Text>
      </Box>

      {digest.failure_groups.map((g) => {
        const isScheduled = g.origin === "scheduled";
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
          </Box>
        );
      })}

      {pending > 0 ? (
        <Box flexDirection="column">
          <Text color="cyan">
            {pending} self-healing fix{pending === 1 ? "" : "es"} awaiting review
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
          {digest.risk.map((r) => {
            const color = r.severity === "critical" ? "red" : "yellow";
            return (
              <Box key={`${r.kind}:${r.headline}`} flexDirection="column">
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
