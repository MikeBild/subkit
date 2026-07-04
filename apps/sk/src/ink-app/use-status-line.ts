// Scriptable status line — rate-limited rebuild ticker.
//
// Assembles the `StatusLineInput` payload from persona + session +
// engine snapshots on every tick and hands it to the (optionally
// user-scripted) `buildStatusLine` renderer. Owns the resulting
// one-line string so the app only renders it.

import type { SkSessionState, ToolCallState } from "@cli-core/index.ts";
import type React from "react";
import { useEffect, useState } from "react";
import type { StatusSummary } from "../engine-client.ts";
import {
  buildStatusLine,
  type PermissionMode,
  resolveRefreshMs,
  type StatusLineConfig,
  type StatusLineInput,
} from "../repl/status-line/render.ts";
import type { ConnectionSnapshot, PersonaInfo, ResumeSummary } from "./types.ts";

function latestToolOutcome(calls: ToolCallState[], names: Set<string>): string | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (!call || !names.has(call.name)) continue;
    if (call.status === "failed") return "failed";
    if (call.status === "done") return "ok";
    return null;
  }
  return null;
}

const PROBE_TOOLS = new Set(["probe_connector", "probe_connector_draft"]);
const PREVIEW_TOOLS = new Set(["dry_run_step", "dry_run_workflow"]);

export interface StatusLineDeps {
  statusLineConfig: StatusLineConfig | undefined;
  persona: PersonaInfo;
  model: string | null | undefined;
  cwd: string | undefined;
  session: SkSessionState;
  statusSnapshot: StatusSummary | null | undefined;
  connectionSnapshot: ConnectionSnapshot | null | undefined;
  activeMode: PermissionMode;
  resumeSummary: ResumeSummary | null | undefined;
  /** Transient status-line message channel (upload progress etc.) —
   *  read from `current` each tick so no state update per chunk. */
  transientStatusRef: React.MutableRefObject<string | null>;
}

export function useStatusLine(deps: StatusLineDeps): string {
  const {
    statusLineConfig,
    persona,
    model,
    cwd,
    session,
    statusSnapshot,
    connectionSnapshot,
    activeMode,
    resumeSummary,
    transientStatusRef,
  } = deps;
  const [statusLine, setStatusLine] = useState<string>("");

  useEffect(() => {
    const refresh = resolveRefreshMs(statusLineConfig);
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const cwdValue = cwd ?? process.cwd();
      const snapTenant = statusSnapshot?.tenant.slug ?? statusSnapshot?.tenant.id ?? null;
      const snapUser = statusSnapshot?.user.email ?? statusSnapshot?.user.id ?? null;
      const input: StatusLineInput = {
        schema_version: 1,
        profile: persona.profileName,
        persona: persona.label,
        user: snapUser,
        auth_status: statusSnapshot ? "signed_in" : "signed_out",
        tenant: snapTenant ?? persona.tenant,
        engine_url: persona.engineUrl,
        model: model ?? null,
        session_id: session.conversationId,
        turn_tokens: session.usage?.turn_tokens ?? null,
        remaining_monthly_budget_tokens:
          session.usage?.remaining_monthly_budget_tokens ??
          statusSnapshot?.remaining_monthly_budget_tokens ??
          null,
        tokens_today: statusSnapshot?.tokens_today ?? null,
        connectors_count: statusSnapshot?.connectors_count ?? null,
        // Surface transient upload progress (and any other short-lived
        // status messages) here. The ref is set by file-paste and
        // knowledge uploads while a presigned PUT is in flight and cleared on
        // completion or failure — matches the upload-progress callback
        // cadence (per-chunk).
        status_message: transientStatusRef.current,
        permission_mode: activeMode,
        cwd: cwdValue,
        git_branch: null,
        timestamp: new Date().toISOString(),
        authoring_mode: resumeSummary?.stage ?? null,
        target_kind: resumeSummary?.active_target.kind ?? null,
        target_name: resumeSummary?.active_target.name ?? null,
        environment: resumeSummary?.active_target.environment ?? null,
        pending_approvals: session.pendingElicitation ? 1 : 0,
        latest_probe_state: latestToolOutcome(session.toolCalls, PROBE_TOOLS),
        latest_preview_state: latestToolOutcome(session.toolCalls, PREVIEW_TOOLS),
        connection_state: connectionSnapshot?.state ?? "unknown",
        connection_reason: connectionSnapshot?.reason ?? null,
      };
      const result = await buildStatusLine(statusLineConfig, input);
      if (!cancelled) setStatusLine(result.line);
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, refresh);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    statusLineConfig,
    persona.label,
    persona.tenant,
    persona.engineUrl,
    persona.profileName,
    model,
    session.conversationId,
    session.usage,
    cwd,
    statusSnapshot,
    connectionSnapshot,
    activeMode,
    resumeSummary,
  ]);

  return statusLine;
}
