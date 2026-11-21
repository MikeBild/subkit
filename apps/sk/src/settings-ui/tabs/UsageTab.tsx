import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";
import { type AiBudget, aiBudgetLabel } from "../../repl/status-line/render.ts";

interface Props {
  client: EngineClient;
}

interface UsageRow {
  flow: string;
  prompt: number;
  completion: number;
  total: number;
}

interface UserRow {
  user_id: string;
  total: number;
}

function startOfMonthIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export const UsageTab: React.FC<Props> = ({ client }) => {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [totalPrompt, setTotalPrompt] = useState(0);
  const [totalCompletion, setTotalCompletion] = useState(0);
  const [cacheRead, setCacheRead] = useState(0);
  const [budget, setBudget] = useState<AiBudget | null>(null);
  const [userRows, setUserRows] = useState<UserRow[]>([]);
  const [canReadAll, setCanReadAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [stats, status, bootstrap] = await Promise.all([
          client.statsLlm({ bucket: "day", from: startOfMonthIso(), group_by: "flow" }),
          client.statusSummary(),
          client.skBootstrap(),
        ]);
        if (cancelled) return;
        const top: UsageRow[] = stats.groups
          .map((g) => ({
            flow: g.key.flow || "unknown",
            prompt: g.totals.tokens.prompt,
            completion: g.totals.tokens.completion,
            total: g.totals.tokens.total,
          }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 5);
        setRows(top);
        setTotalPrompt(stats.totals.tokens.prompt);
        setTotalCompletion(stats.totals.tokens.completion);
        setCacheRead(stats.totals.tokens.cache_read);
        setBudget(status.ai_budget);

        const allowed = (bootstrap.permissions ?? []).includes("stats:read:all");
        setCanReadAll(allowed);
        if (allowed) {
          const byUser = await client.statsLlm({
            bucket: "day",
            from: startOfMonthIso(),
            group_by: "user",
          });
          if (cancelled) return;
          const users: UserRow[] = byUser.groups
            .map((g) => ({ user_id: g.key.user || "(system)", total: g.totals.tokens.total }))
            .filter((u) => u.total > 0)
            .sort((a, b) => b.total - a.total)
            .slice(0, 5);
          setUserRows(users);
        } else {
          setUserRows([]);
        }
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
  const cacheHitPct = totalPrompt > 0 ? ((cacheRead / totalPrompt) * 100).toFixed(1) : "0.0";
  return (
    <Box flexDirection="column">
      <Text bold>Token usage</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Month-to-date AI usage for this tenant.</Text>
        <Text color="gray">
          totals: {totalPrompt.toLocaleString()} input + {totalCompletion.toLocaleString()} output ={" "}
          {grandTotal.toLocaleString()} tokens · cache hit {cacheHitPct}%
        </Text>
        {budget?.limit != null ? (
          <BudgetBar budget={budget} />
        ) : (
          <Text color="gray">monthly AI budget: no limit</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Top 5 flows by total tokens (this month)</Text>
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {!loading && !error && rows.length === 0 ? (
          <Text color="gray">no AI requests recorded for this tenant this month</Text>
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
      {canReadAll ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Top 5 users by total tokens (this month)</Text>
          {userRows.length === 0 ? (
            <Text color="gray">no attributed per-user usage this month</Text>
          ) : null}
          {userRows.map((u) => (
            <UsageBar
              key={u.user_id}
              flow={u.user_id.slice(0, 18)}
              total={u.total}
              prompt={0}
              completion={0}
              max={userRows[0]?.total ?? 1}
            />
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">r refresh · Esc closes</Text>
      </Box>
    </Box>
  );
};

const BudgetBar: React.FC<{ budget: AiBudget }> = ({ budget }) => {
  const width = 24;
  const limit = budget.limit ?? 0;
  const ratio = limit > 0 ? Math.min(1, budget.spent / limit) : 0;
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  const pct = (ratio * 100).toFixed(0);
  const color = ratio >= 1 ? "red" : ratio >= 0.8 ? "yellow" : "green";
  return (
    <Box>
      <Box width={20}>
        <Text>monthly AI budget</Text>
      </Box>
      <Text color={color}>{bar}</Text>
      <Text color="gray">
        {" "}
        {pct}% ({aiBudgetLabel(budget)})
      </Text>
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
        {total.toLocaleString()}
        {prompt > 0 || completion > 0
          ? ` (${prompt.toLocaleString()} p + ${completion.toLocaleString()} c)`
          : ""}
      </Text>
    </Box>
  );
};
