import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";
import { resolveAction } from "../keybindings/useKeybinding.ts";

interface Props {
  client: EngineClient;
  onInnerEscape?: (active: boolean) => void;
}

interface SkillRow {
  id: string;
  title: string;
  scope: string;
  status: string;
}

export const SkillsTab: React.FC<Props> = ({ client, onInnerEscape }) => {
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listIdx, setListIdx] = useState(0);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [activationFlash, setActivationFlash] = useState<string | null>(null);

  useEffect(() => {
    onInnerEscape?.(searchActive || searchQuery.length > 0);
  }, [searchActive, searchQuery, onInnerEscape]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await client.listSkills();
        if (cancelled) return;
        const next: SkillRow[] = res.items.map((it) => ({
          id: it.id,
          title: it.title,
          scope: it.scope,
          status: it.status,
        }));
        setRows(next);
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
  }, [client]);

  const filtered = useMemo(() => {
    if (!searchQuery) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((r) => r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  }, [rows, searchQuery]);

  useEffect(() => {
    if (listIdx > Math.max(0, filtered.length - 1)) setListIdx(0);
  }, [filtered.length, listIdx]);

  const toggle = async (row: SkillRow): Promise<void> => {
    setToggleError(null);
    setActivationFlash(null);
    try {
      if (row.status === "active") {
        await client.archiveSkill(row.id);
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "archived" } : r)));
        setActivationFlash(`archived ${row.title}`);
      } else {
        const wasDraft = row.status === "draft";
        await client.activateSkill(row.id);
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "active" } : r)));
        setActivationFlash(
          wasDraft ? `activated draft skill ${row.title}` : `activated ${row.title}`,
        );
      }
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : String(err));
    }
  };

  useInput((input, key) => {
    if (searchActive) {
      const action = resolveAction("Search", input, key);
      if (action === "search:clear") {
        setSearchQuery("");
        setSearchActive(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && input !== "/") {
        setSearchQuery((q) => q + input);
        return;
      }
      return;
    }
    if (input === "/") {
      setSearchActive(true);
      return;
    }
    if (key.upArrow) {
      setListIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setListIdx((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (input === " " || key.return) {
      const sel = filtered[listIdx];
      if (sel) void toggle(sel);
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Skills</Text>
      <Box>
        <Text color="gray">↑/↓ navigate · space / Enter toggles active/archived · / filter</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {toggleError ? <Text color="red">toggle failed: {toggleError}</Text> : null}
        {activationFlash ? <Text color="green">{activationFlash}</Text> : null}
        {!loading && !error && filtered.length === 0 ? (
          <Text color="gray">
            {searchQuery ? `no skills match "${searchQuery}"` : "no skills available"}
          </Text>
        ) : null}
        {filtered.map((r, i) => (
          <Box key={r.id}>
            <Text color={i === listIdx ? "cyan" : "white"}>{i === listIdx ? "› " : "  "}</Text>
            <Text>{r.status === "active" ? "[x] " : "[ ] "}</Text>
            <Text color={r.status === "active" ? "green" : "gray"}>{r.title}</Text>
            <Text color="gray"> ({r.scope})</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};
