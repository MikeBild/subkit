// Status tab — runtime snapshot. Live MCP polling at 5s while the tab
// is mounted; cleanup on unmount cancels the timer (tab unmounts when
// the outer shell switches tabs, so polling stops).
//
// Embeds the activity heatmap below the runtime properties (former
// Stats tab, merged into Status).
// The heatmap captures `1`/`2`/`3` for window toggles via its own
// useInput; StatusTab itself has no key handlers, so there is no
// collision.
//
// Note: rows that depend on REPL state (session id, cwd-relative
// permission mode, token-usage) require coupling that doesn't exist in
// the standalone `sk settings` invocation. Those rows render "unknown"
// here and are populated only when the modal is hosted by the REPL.

import { VERSION as CLI_VERSION } from "@cli-core/version.ts";
import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";
import { ActivityHeatmap } from "../components/ActivityHeatmap.tsx";
import type { FormField } from "../lib/zod-to-form-fields.ts";

interface Props {
  client: EngineClient;
  fields: FormField[];
  pendingRestartKeys: readonly string[];
  overrideKeys: readonly string[];
  /** Optional REPL-state passthroughs. Render `—` when null/undefined. */
  sessionId?: string | null;
  sessionTitle?: string | null;
  permissionMode?: "ask" | "auto" | "plan" | "yolo" | null;
  sessionTokens?: number | null;
  weekTokens?: number | null;
}

const POLL_INTERVAL_MS = 5_000;

interface BootstrapSnapshot {
  email: string | null;
  tenant: string | null;
  role: string | null;
  engineBaseUrl: string | null;
}

interface McpSnapshot {
  toolCount: number | null;
  promptCount: number | null;
  resourceCount: number | null;
  error: string | null;
  lastChecked: number | null;
}

const EMPTY_MCP: McpSnapshot = {
  toolCount: null,
  promptCount: null,
  resourceCount: null,
  error: null,
  lastChecked: null,
};

export const StatusTab: React.FC<Props> = ({
  client,
  fields,
  pendingRestartKeys,
  overrideKeys,
  sessionId,
  sessionTitle,
  permissionMode,
  sessionTokens,
  weekTokens,
}) => {
  const [boot, setBoot] = useState<BootstrapSnapshot | null>(null);
  const [mcp, setMcp] = useState<McpSnapshot>(EMPTY_MCP);
  const [bootError, setBootError] = useState<string | null>(null);

  // One-shot bootstrap fetch for identity + engine base URL.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await client.skBootstrap();
        if (cancelled) return;
        setBoot({
          email: b.whoami.email,
          tenant: b.tenant.slug ?? b.whoami.tenant_slug,
          role: b.whoami.role_name,
          engineBaseUrl: b.whoami.base_url,
        });
      } catch (err) {
        if (cancelled) return;
        setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // 5s MCP catalog poll; cleanup cancels the timer.
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async (): Promise<void> => {
      try {
        const [tools, prompts, resources] = await Promise.all([
          client.listMcpTools(),
          client.listMcpPrompts(),
          client.listMcpResources(),
        ]);
        if (cancelled) return;
        setMcp({
          toolCount: tools.items?.length ?? null,
          promptCount: prompts.items?.length ?? null,
          resourceCount: resources.items?.length ?? null,
          error: null,
          lastChecked: Date.now(),
        });
      } catch (err) {
        if (cancelled) return;
        setMcp((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
          lastChecked: Date.now(),
        }));
      }
    };
    void fetchOnce();
    const id = setInterval(() => {
      void fetchOnce();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client]);

  const modelField = fields.find((f) => f.path === "llm.model");
  const modelValue =
    modelField && typeof modelField.value === "string" ? modelField.value : "unknown";

  const settingSources = [
    overrideKeys.length > 0 ? `${overrideKeys.length} override(s)` : null,
    pendingRestartKeys.length > 0 ? `${pendingRestartKeys.length} pending-restart` : null,
  ].filter((s): s is string => s !== null);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Runtime status</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <StatusRow label="cli version" value={`v${CLI_VERSION}`} />
        <StatusRow label="cwd" value={process.cwd()} />
        <StatusRow label="session id" value={sessionId ? sessionId.slice(0, 8) : "—"} />
        <StatusRow
          label="session name"
          value={
            sessionTitle && sessionTitle.length > 0
              ? sessionTitle
              : sessionId
                ? "(untitled · /rename to set)"
                : "—"
          }
        />
        <StatusRow
          label="login"
          value={bootError ? `error: ${bootError}` : boot ? (boot.email ?? "—") : "loading…"}
        />
        <StatusRow label="tenant" value={boot?.tenant ?? "—"} />
        <StatusRow label="role" value={boot?.role ?? "—"} />
        <StatusRow label="engine" value={boot?.engineBaseUrl ?? "—"} />
        <StatusRow label="model" value={modelValue} />
        <StatusRow label="permission mode" value={permissionMode ?? "—"} />
        <StatusRow
          label="tokens · session"
          value={typeof sessionTokens === "number" ? sessionTokens.toLocaleString() : "—"}
        />
        <StatusRow
          label="tokens · this week"
          value={typeof weekTokens === "number" ? weekTokens.toLocaleString() : "—"}
        />
        <StatusRow
          label="mcp"
          value={
            mcp.error
              ? `failed: ${mcp.error}`
              : mcp.lastChecked === null
                ? "loading…"
                : `${mcp.toolCount ?? 0} tools · ${mcp.promptCount ?? 0} prompts · ${
                    mcp.resourceCount ?? 0
                  } resources`
          }
        />
        <StatusRow
          label="setting sources"
          value={settingSources.length > 0 ? settingSources.join(" · ") : "all defaults"}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">─────────────────────────────</Text>
      </Box>
      <Box marginTop={1}>
        <ActivityHeatmap client={client} />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          MCP catalog refreshes every {POLL_INTERVAL_MS / 1000}s while this tab is open.
        </Text>
      </Box>
    </Box>
  );
};

const StatusRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box>
    <Box width={20}>
      <Text color="gray">{label}</Text>
    </Box>
    <Text>{value}</Text>
  </Box>
);
