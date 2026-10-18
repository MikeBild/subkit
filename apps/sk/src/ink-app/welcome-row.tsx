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
import type { PendingIntake } from "../lib/intake-review.ts";
import { ResumeSummaryCard } from "../repl/authoring-cards.tsx";
import { NeedsAttentionPanel } from "../repl/needs-attention-panel.tsx";
import { buildStarterActions } from "../repl/starter-action-injection.ts";
import { StarterActions } from "../repl/starter-actions.tsx";
import type { PermissionMode } from "../repl/status-line/render.ts";
import { classifyVersionSkew, VersionMismatchBanner } from "../repl/version-mismatch-banner.tsx";
import { WelcomeBanner } from "../repl/welcome-banner.tsx";
import type { ConnectionSnapshot, PersonaInfo, ResumeSummary, TranscriptMode } from "./types.ts";

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
  pendingIntake?: PendingIntake | null | undefined;
  tip: string;
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
  pendingIntake = null,
  tip,
}) => {
  const setupBannerShownRef = useRef(false);
  useEffect(() => {
    if (!setupSnapshot || setupSnapshot.overall_status === "ok") {
      setupBannerShownRef.current = false;
      return;
    }
    setupBannerShownRef.current = true;
  }, [setupSnapshot]);

  const hasDigest = Boolean(
    digestSnapshot &&
      (digestSnapshot.failure_groups.length > 0 ||
        digestSnapshot.risk.length > 0 ||
        digestSnapshot.patch_candidates.open > 0),
  );
  const digestNode =
    hasDigest && digestSnapshot ? <NeedsAttentionPanel digest={digestSnapshot} /> : null;

  const starterActions = useMemo(
    () => buildStarterActions(persona.label, persona.probe, digestSnapshot, pendingIntake),
    [persona.label, persona.probe, digestSnapshot, pendingIntake],
  );

  const canShowSetupBanner =
    persona.probe.allows("audit:read") || persona.probe.allows("identity:read");
  const setupBannerNode =
    canShowSetupBanner && setupSnapshot && setupSnapshot.overall_status !== "ok"
      ? renderSetupBanner(setupSnapshot)
      : null;

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
