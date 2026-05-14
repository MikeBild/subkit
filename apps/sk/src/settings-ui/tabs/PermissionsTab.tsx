// Permissions tab — radio Default / Auto-review / Full Access.
// Maps onto the sk REPL's permission_mode (`ask` / `auto` / `yolo`)
// and persists via the engine setting `repl.permissionMode`. Loads
// the current value from the engine on mount; Enter writes via
// `setSetting`. Inline error reported on failure; success flash on
// commit.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";

export type ReplPermissionMode = "ask" | "auto" | "yolo" | "plan";

interface Option {
  mode: ReplPermissionMode;
  label: string;
  desc1: string;
  desc2: string;
}

const OPTIONS: readonly Option[] = [
  {
    mode: "ask",
    label: "Default",
    desc1: "Confirm every destructive or unbounded action.",
    desc2: "Safest default; most interactive.",
  },
  {
    mode: "auto",
    label: "Auto-review",
    desc1: "Auto-run reads + safe writes; pause for destructive ops.",
    desc2: "Recommended for engaged workflow editing.",
  },
  {
    mode: "plan",
    label: "Plan only",
    desc1: "Drafts only; no engine writes; useful for design reviews.",
    desc2: "Pairs with /draft for connector + workflow YAML authoring.",
  },
  {
    mode: "yolo",
    label: "Full Access",
    desc1: "Auto-confirm everything. Time-bounded — auto-disarms.",
    desc2: "Use only for short, high-trust workflow windows.",
  },
] as const;

interface Props {
  initial?: ReplPermissionMode;
  client?: EngineClient;
  tenant?: string;
  onSelect?: (mode: ReplPermissionMode) => void;
}

export const PermissionsTab: React.FC<Props> = ({ initial, client, tenant, onSelect }) => {
  const [active, setActive] = useState<ReplPermissionMode>(initial ?? "ask");
  const [idx, setIdx] = useState(() =>
    Math.max(
      0,
      OPTIONS.findIndex((o) => o.mode === (initial ?? "ask")),
    ),
  );
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);
  const [loadedFromEngine, setLoadedFromEngine] = useState(false);

  // Hydrate from engine on mount when no `initial` was supplied.
  useEffect(() => {
    if (!client || initial !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const opts: { tenant?: string } = tenant ? { tenant } : {};
        const res = await client.listSettings(opts);
        const leaf = res.items.find((it) => it.path === "repl.permissionMode");
        const value = leaf && typeof leaf.value === "string" ? leaf.value : null;
        if (
          !cancelled &&
          value &&
          (value === "ask" || value === "auto" || value === "plan" || value === "yolo")
        ) {
          setActive(value);
          setIdx(
            Math.max(
              0,
              OPTIONS.findIndex((o) => o.mode === value),
            ),
          );
          setLoadedFromEngine(true);
        }
      } catch {
        // non-fatal; the radio still works as a session-only toggle.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, tenant, initial]);

  const commit = async (mode: ReplPermissionMode): Promise<void> => {
    setActive(mode);
    onSelect?.(mode);
    if (!client) {
      setFlash({ kind: "ok", msg: "applied (session-only — no engine client wired)" });
      return;
    }
    try {
      const opts: { tenant?: string } = tenant ? { tenant } : {};
      await client.setSetting("repl.permissionMode", mode, opts);
      setFlash({ kind: "ok", msg: `repl.permissionMode = ${mode} written` });
    } catch (err) {
      setFlash({
        kind: "error",
        msg: `setSetting failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  useInput((_input, key) => {
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(OPTIONS.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const sel = OPTIONS[idx];
      if (!sel) return;
      void commit(sel.mode);
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Permission mode</Text>
      <Box>
        <Text color="gray">↑/↓ select · Enter applies (writes repl.permissionMode)</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((o, i) => (
          <Box key={o.mode} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={i === idx ? "cyan" : "gray"}>{i === idx ? "› " : "  "}</Text>
              <Text color={o.mode === active ? "green" : "white"} bold={o.mode === active}>
                {o.mode === active ? "(•) " : "( ) "}
                {o.label}
              </Text>
              <Text color="gray"> — {o.mode}</Text>
            </Box>
            <Box paddingLeft={4} flexDirection="column">
              <Text color="gray">{o.desc1}</Text>
              <Text color="gray">{o.desc2}</Text>
            </Box>
          </Box>
        ))}
      </Box>
      {flash ? (
        <Box marginTop={1}>
          <Text color={flash.kind === "error" ? "red" : "green"}>
            {flash.kind === "error" ? "✗ " : "✔ "}
            {flash.msg}
          </Text>
        </Box>
      ) : null}
      {loadedFromEngine ? (
        <Box marginTop={1}>
          <Text color="gray">Loaded current value from engine setting `repl.permissionMode`.</Text>
        </Box>
      ) : null}
    </Box>
  );
};
