// Usage tab — token usage progress bars + last-N top contributors,
// sourced from the existing `llm.invocation` audit events. Each
// `llm.invocation` row's metadata carries `prompt_tokens` and
// `completion_tokens`; we aggregate by `metadata.flow` (sk's existing
// flow taxonomy: `chat`, `summarize`, `tool-chain`, etc.) so the
// operator can see where their tokens went.
//
// Keymap: `r` re-fetches; Esc is owned by the outer modal.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";

interface Props {
  client: EngineClient;
}

interface AuditEntry {
  action?: unknown;
  metadata?: unknown;
}

interface UsageRow {
  flow: string;
  prompt: number;
  completion: number;
  total: number;
}

function readNumber(o: unknown, key: string): number {
  if (!o || typeof o !== "object") return 0;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readString(o: unknown, key: string, fallback: string): string {
  if (!o || typeof o !== "object") return fallback;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export const UsageTab: React.FC<Props> = ({ client }) => {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [totalPrompt, setTotalPrompt] = useState(0);
  const [totalCompletion, setTotalCompletion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await client.tailAuditLog({ action: "llm.invocation", limit: 200 });
        if (cancelled) return;
        const tally = new Map<string, UsageRow>();
        let pTotal = 0;
        let cTotal = 0;
        for (const raw of res.items as AuditEntry[]) {
          if (raw.action !== "llm.invocation") continue;
          const flow = readString(raw.metadata, "flow", "unknown");
          const p = readNumber(raw.metadata, "prompt_tokens");
          const c = readNumber(raw.metadata, "completion_tokens");
          pTotal += p;
          cTotal += c;
          const cur = tally.get(flow) ?? { flow, prompt: 0, completion: 0, total: 0 };
          cur.prompt += p;
          cur.completion += c;
          cur.total += p + c;
          tally.set(flow, cur);
        }
        const top = [...tally.values()].sort((a, b) => b.total - a.total).slice(0, 5);
        setRows(top);
        setTotalPrompt(pTotal);
        setTotalCompletion(cTotal);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, refreshKey]);

  useInput((input) => {
    if (input === "r") setRefreshKey((k) => k + 1);
  });

  const grandTotal = totalPrompt + totalCompletion;
  return (
    <Box flexDirection="column">
      <Text bold>Token usage</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Last 200 AI requests for this tenant.</Text>
        <Text color="gray">
          totals: {totalPrompt.toLocaleString()} input + {totalCompletion.toLocaleString()} output ={" "}
          {grandTotal.toLocaleString()} tokens
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Top 5 flows by total tokens</Text>
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {!loading && !error && rows.length === 0 ? (
          <Text color="gray">no AI requests recorded for this tenant yet</Text>
        ) : null}
        {rows.map((r) => (
          <UsageBar
            key={r.flow}
            flow={r.flow}
            total={r.total}
            prompt={r.prompt}
            completion={r.completion}
            max={rows[0]?.total ?? 1}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">r refresh · Esc closes</Text>
      </Box>
    </Box>
  );
};

const UsageBar: React.FC<{
  flow: string;
  total: number;
  prompt: number;
  completion: number;
  max: number;
}> = ({ flow, total, prompt, completion, max }) => {
  const width = 24;
  const filled = max > 0 ? Math.max(1, Math.round((total / max) * width)) : 0;
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  return (
    <Box>
      <Box width={20}>
        <Text>{flow.slice(0, 18)}</Text>
      </Box>
      <Text color="cyan">{bar}</Text>
      <Text color="gray">
        {" "}
        {total.toLocaleString()} ({prompt.toLocaleString()} p + {completion.toLocaleString()} c)
      </Text>
    </Box>
  );
};
