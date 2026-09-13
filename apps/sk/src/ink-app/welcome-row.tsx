// First-scrollback-row chrome for the Ink REPL.
//
// Bundles everything that renders once above the transcript: the
// version-skew banner, the setup-validation banner, the welcome
// panel, the operator-health digest, starter actions, and the resume
// summary card. The whole row is pushed into Ink's <Static> stream as
// the very first scrollback row by the transcript builder.

import { useTheme } from "@chat-ui/index.ts";
import { VERSION as CLI_VERSION } from "@cli-core/version.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo, useEffect, useMemo, useRef } from "react";

import type {
  OperatorHealthDigest,
  SetupValidationResponse,
  StatusSummary,
} from "../engine-client.ts";
import { ResumeSummaryCard } from "../repl/authoring-cards.tsx";
import { NeedsAttentionPanel } from "../repl/needs-attention-panel.tsx";
import { buildStarterActions } from "../repl/starter-action-injection.ts";
import { StarterActions } from "../repl/starter-actions.tsx";
import type { PermissionMode } from "../repl/status-line/render.ts";
import { classifyVersionSkew, VersionMismatchBanner } from "../repl/version-mismatch-banner.tsx";
import { WelcomeBanner } from "../repl/welcome-banner.tsx";
import type { ConnectionSnapshot, PersonaInfo, ResumeSummary, TranscriptMode } from "./types.ts";

// ---------- Setup-validation banner ----------
//
// One-line orange/red banner rendered ABOVE the welcome panel when
// `GET /v1/diagnostics/setup` reports a non-`ok` overall status.
// Sticky for the session — the same node is emitted every render
// until the status flips back to `ok`. The host (`ink-repl.ts`)
// owns the polling cadence; this component is a pure renderer.
//
//   warn    →  ⚠ Setup: {N} warning(s) — run /setup for details
//   blocked →  ✗ Setup: {N} blocking issue(s) — run /setup to resolve
//
// Colors come from the active theme so light-on-light terminals don't
// produce an unreadable result. The banner must NOT redraw or flash
// on every render — wrapping in <memo> below pins the props at the
// snapshot identity, so as long as `setupSnapshot` doesn't change
// React reuses the existing node.

function renderSetupBanner(snapshot: SetupValidationResponse): React.ReactNode {
  return (
    <SetupBanner
      key={`setup-banner-${snapshot.overall_status}`}
      status={snapshot.overall_status}
      warnings={snapshot.summary_counts.warnings}
      blockers={snapshot.summary_counts.blockers}
    />
  );
}

interface SetupBannerProps {
  status: "warn" | "blocked" | "ok";
  warnings: number;
  blockers: number;
}

const SetupBanner: React.FC<SetupBannerProps> = memo(({ status, warnings, blockers }) => {
  const theme = useTheme();
  if (status === "ok") return null;
  if (status === "warn") {
    const label = `${warnings} warning${warnings === 1 ? "" : "s"}`;
    return (
      <Box>
        <Text color={theme.severity.warning} bold>
          {`⚠ Setup: ${label}. Type `}
        </Text>
        <Text color={theme.severity.warning} bold>
          /setup
        </Text>
      </Box>
    );
  }
  // blocked
  const label = `${blockers} blocking issue${blockers === 1 ? "" : "s"}`;
  return (
    <Box>
      <Text color={theme.severity.error} bold>
        {`✗ Setup: ${label}. Type `}
      </Text>
      <Text color={theme.severity.error} bold>
        /setup
      </Text>
    </Box>
  );
});
SetupBanner.displayName = "SetupBanner";

// ---------- Welcome row ----------

export interface WelcomeRowProps {
  persona: PersonaInfo;
  conversationId: string | null;
  activeMode: PermissionMode;
  transcriptMode: TranscriptMode;
  connectionSnapshot: ConnectionSnapshot | null | undefined;
  resumeSummary: ResumeSummary | null | undefined;
  statusSnapshot: StatusSummary | null | undefined;
  setupSnapshot: SetupValidationResponse | null | undefined;
  digestSnapshot: OperatorHealthDigest | null | undefined;
  /** Proposed session-learning count; > 0 (with skill:read) injects the
   *  review-learnings starter action. Absent = 0 = today's behavior. */
  pendingLearningsCount?: number | undefined;
  tip: string;
  whatsNew: string | null;
}

export const WelcomeRow: React.FC<WelcomeRowProps> = ({
  persona,
  conversationId,
  activeMode,
  transcriptMode,
  connectionSnapshot,
  resumeSummary,
  statusSnapshot,
  setupSnapshot,
  digestSnapshot,
  pendingLearningsCount = 0,
  tip,
  whatsNew,
}) => {
  const setupBannerShownRef = useRef(false);
  // Setup-validation banner gating. The actual one-line banner renders
  // in the row below so it sits above the welcome panel as the very
  // first scrollback row. This effect only owns the "have we already
  // announced this status" memo so a repeated `setupSnapshot` push
  // (e.g. after a manual `/setup` refresh) does not flash the banner
  // twice in the notice stack. The render path is sticky on its own —
  // it emits the same node every render until the status flips back
  // to `ok`.
  useEffect(() => {
    if (!setupSnapshot || setupSnapshot.overall_status === "ok") {
      setupBannerShownRef.current = false;
      return;
    }
    setupBannerShownRef.current = true;
  }, [setupSnapshot]);

  // Digest = in-context chrome below the welcome box; with failures (and the
  // permission to act) it also injects a key-"1" guided-triage starter action.
  const hasDigest = Boolean(
    digestSnapshot &&
    (digestSnapshot.failure_groups.length > 0 ||
      digestSnapshot.risk.length > 0 ||
      digestSnapshot.patch_candidates.pending > 0),
  );
  const digestNode =
    hasDigest && digestSnapshot ? <NeedsAttentionPanel digest={digestSnapshot} /> : null;

  // Render + dispatch lists derive injection (and the RBAC gate) from the same
  // (probe, digest, pendingLearnings) inputs inside the shared helpers, so
  // they can't drift.
  const starterActions = useMemo(
    () => buildStarterActions(persona.label, persona.probe, digestSnapshot, pendingLearningsCount),
    [persona.label, persona.probe, digestSnapshot, pendingLearningsCount],
  );

  // Setup-validation banner. Rendered as a one-line orange/red row
  // ABOVE the welcome panel so the operator sees a degraded engine
  // before they read the first tip. Visibility gated on:
  //   * setupSnapshot present and overall_status !== "ok"
  //   * persona can read /v1/diagnostics (admin or member)
  // Operators without `audit:read` / `identity:read` cannot meaningfully
  // act on the diagnostics endpoint, so we suppress the banner for
  // them — matches the existing `/setup` slash gating.
  const canShowSetupBanner =
    persona.probe.allows("audit:read") || persona.probe.allows("identity:read");
  const setupBannerNode =
    canShowSetupBanner && setupSnapshot && setupSnapshot.overall_status !== "ok"
      ? renderSetupBanner(setupSnapshot)
      : null;

  // Sticky version-skew banner: compares CLI VERSION to engine
  // /v1/status.version. Mismatch → operator sees a one-line hint
  // pointing at the rebuild command. Pre-fix this triage cost a
  // 2-cycle "why isn't my fix landing" debug session.
  const versionSkewNode = statusSnapshot
    ? (() => {
        const skew = classifyVersionSkew(CLI_VERSION, statusSnapshot.version);
        if (skew.severity === "match" || skew.severity === "dev_build") return null;
        return <VersionMismatchBanner snapshot={skew} />;
      })()
    : null;

  return (
    <Box flexDirection="column">
      {versionSkewNode}
      {setupBannerNode}
      <WelcomeBanner
        persona={persona.label}
        tenant={persona.tenant}
        engineUrl={persona.engineUrl}
        profileName={persona.profileName}
        sessionId={conversationId}
        mode={activeMode}
        transcriptMode={transcriptMode}
        connectionState={connectionSnapshot?.state ?? "unknown"}
        connectionReason={connectionSnapshot?.reason ?? null}
        targetKind={resumeSummary?.active_target.kind ?? null}
        targetName={resumeSummary?.active_target.name ?? null}
        environment={resumeSummary?.active_target.environment ?? null}
        tip={tip}
        whatsNew={whatsNew}
        signedIn={Boolean(statusSnapshot?.user.email) || persona.tenant !== null}
      />
      {digestNode}
      {starterActions.length > 0 ? <StarterActions actions={starterActions} /> : null}
      {resumeSummary ? (
        <ResumeSummaryCard
          active_target={resumeSummary.active_target}
          stage={resumeSummary.stage}
          next_action={resumeSummary.next_action}
          one_sentence={resumeSummary.one_sentence}
          last_successful_probe={resumeSummary.last_successful_probe}
          last_successful_preview={resumeSummary.last_successful_preview}
        />
      ) : null}
    </Box>
  );
};
