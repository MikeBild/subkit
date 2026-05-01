// Generic approval body — last-resort renderer for `kind: "other"`
// or any unknown approval shape. Prints the target (if any) and
// a pretty-printed JSON dump of the diff so the operator has
// something to audit before approving.
//
// When the approval carries a mutating `commit_intent`, the generic
// renderer is upgraded to a side-by-side `JsonDiff` against the
// current persisted state. This is the visual upgrade for gap #9 —
// operators see exactly which field will change before saying "ok".
// Fetches are cached for 60 seconds per (kind, id) pair so a fresh
// confirmation prompt within that window reuses the prior fetch.
//
// Cache scope: module-level Map keyed by `${kind}:${id}`. The cache
// lives for the life of the REPL process, which matches the spec's
// "per-conversation 60s TTL" because every conversation runs inside
// one REPL process. If the cache misses, fetches run in parallel
// with a "loading diff..." line so the rest of the approval UI
// stays interactive.

import type { CommitIntent } from "@engine/conversations/tools/ask-user/commit-intent.ts";
import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { debugLog } from "../../debug.ts";
import type { EngineClient } from "../../engine-client.ts";
import { JsonDiff } from "../diff-render.tsx";

function truncate(value: unknown, maxBytes = 600): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return s.length > maxBytes ? `${s.slice(0, maxBytes)}\n… (truncated)` : s;
}

export interface GenericApprovalProps {
  diff: unknown;
  target: unknown;
  /**
   * When set, the renderer fetches the current persisted state for
   * the resource referenced by `commit_intent.payload` and renders a
   * `<JsonDiff />`. Only mutating intents (`save_connector_draft`,
   * `save_workflow_draft`, `update_connector`, `update_workflow`)
   * trigger the upgrade — others fall through to the legacy text
   * dump.
   */
  commitIntent?: CommitIntent | undefined;
  /** Engine client used to fetch the current persisted state. */
  engineClient?: EngineClient | undefined;
  /** Disable JsonDiff's input listener (tests own focus). */
  inputDisabled?: boolean | undefined;
}

const MUTATING_INTENT_KINDS: ReadonlySet<string> = new Set([
  "save_connector_draft",
  "save_workflow_draft",
  "update_connector",
  "update_workflow",
]);

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  ts: number;
  value: Record<string, unknown> | null;
}

const persistedStateCache = new Map<string, CacheEntry>();

/** Test seam — exposed for the diff-render test to clear between cases. */
export function _resetPersistedStateCache(): void {
  persistedStateCache.clear();
}

function readResourceTarget(intent: CommitIntent): {
  kind: "connector" | "workflow";
  id: string;
} | null {
  // Cast to string so the comparison is structural rather than against
  // the narrow `CommitIntentKind` union — `update_connector` /
  // `update_workflow` aren't (yet) members of that union but the
  // dispatcher accepts them prospectively.
  const kind = intent.kind as string;
  if (kind === "save_connector_draft" || kind === "update_connector") {
    const id = readId(intent.payload, ["connector_id", "id"]);
    return id ? { kind: "connector", id } : null;
  }
  if (kind === "save_workflow_draft" || kind === "update_workflow") {
    const id = readId(intent.payload, ["target_workflow_id", "workflow_id", "id"]);
    return id ? { kind: "workflow", id } : null;
  }
  return null;
}

function readId(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

async function fetchPersistedState(
  client: EngineClient,
  target: { kind: "connector" | "workflow"; id: string },
  now: number,
): Promise<Record<string, unknown> | null> {
  const cacheKey = `${target.kind}:${target.id}`;
  const cached = persistedStateCache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.value;
  const fetched =
    target.kind === "connector"
      ? await client.getConnector(target.id)
      : await client.getWorkflow(target.id);
  persistedStateCache.set(cacheKey, { ts: now, value: fetched });
  return fetched;
}

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; current: Record<string, unknown> | null }
  | { status: "error"; message: string };

export const GenericApproval: React.FC<GenericApprovalProps> = ({
  diff,
  target,
  commitIntent,
  engineClient,
  inputDisabled,
}) => {
  const isMutating = commitIntent != null && MUTATING_INTENT_KINDS.has(commitIntent.kind);
  const resourceTarget = isMutating && commitIntent ? readResourceTarget(commitIntent) : null;
  const canFetch = isMutating && resourceTarget != null && engineClient != null;

  const [fetchState, setFetchState] = useState<FetchState>(
    canFetch ? { status: "loading" } : { status: "idle" },
  );

  useEffect(() => {
    if (!canFetch || !engineClient || !resourceTarget) return;
    let cancelled = false;
    const now = Date.now();
    fetchPersistedState(engineClient, resourceTarget, now)
      .then((current) => {
        if (cancelled) return;
        setFetchState({ status: "ready", current });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "fetch failed";
        debugLog("approval.diff_fetch_failed", {
          resource_kind: resourceTarget.kind,
          resource_id: resourceTarget.id,
          error: message,
        });
        setFetchState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [canFetch, engineClient, resourceTarget]);

  const proposedPayload = commitIntent?.payload ?? null;

  // Mutating + can fetch: render the structured JsonDiff (with a
  // fallback when the fetch fails).
  if (isMutating && canFetch) {
    if (fetchState.status === "loading") {
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text dimColor>loading diff...</Text>
        </Box>
      );
    }
    if (fetchState.status === "error") {
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text color="yellow">(diff unavailable: {fetchState.message})</Text>
          {renderTextFallback(diff, target)}
        </Box>
      );
    }
    if (fetchState.status === "ready") {
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text dimColor>
            {fetchState.current === null ? "creating new" : "updating"}{" "}
            {resourceTarget?.kind ?? "resource"}
          </Text>
          <JsonDiff
            before={fetchState.current}
            after={proposedPayload}
            inputDisabled={inputDisabled}
          />
          {commitIntent?.description ? (
            <Box marginTop={1}>
              <Text dimColor>summary: {commitIntent.description}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }
  }

  // Mutating intent without an engine client (e.g. unit-test path):
  // still show the structured JsonDiff against `null` so the user
  // sees the proposed payload field-by-field.
  if (isMutating && proposedPayload) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text dimColor>(diff unavailable: no engine client)</Text>
        <JsonDiff before={null} after={proposedPayload} inputDisabled={inputDisabled} />
      </Box>
    );
  }

  return renderTextFallback(diff, target);
};

function renderTextFallback(diff: unknown, target: unknown): React.ReactElement {
  const hasDiff = diff !== null && diff !== undefined;
  const hasTarget = target !== null && target !== undefined;
  if (!hasDiff && !hasTarget) {
    return (
      <Box marginTop={1}>
        <Text dimColor>(no additional payload)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {hasTarget ? (
        <Box flexDirection="column">
          <Text dimColor>target:</Text>
          <Text>{truncate(target)}</Text>
        </Box>
      ) : null}
      {hasDiff ? (
        <Box flexDirection="column" marginTop={hasTarget ? 1 : 0}>
          <Text dimColor>diff:</Text>
          <Text>{truncate(diff)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
