// CLI ↔ engine version-mismatch banner. Without it, the engine
// container can run an older binary while sk-CLI ships fixes —
// symptoms like "loop_authoring_requires_inspect after a successful
// probe" reproduce because a probe-evidence fix exists in source but
// not in the running container.
//
// The banner runs the same comparison the operator would do
// manually: `sk --version` vs. `GET /v1/status` -> `version`.
// Mismatch surfaces as a sticky banner above the welcome panel
// with one of three severities:
//
//   ↻  CLI v3.2.1 → engine v3.2.0 (engine is older — rebuild image)
//   ⚠  CLI v3.2.0 → engine v3.2.1 (CLI is older — bump sk and reinstall)
//   ◦  CLI v0.0.0-dev (development build — version skew not enforced)
//
// We never block the session — the CLI is always usable — but the
// hint short-circuits the "why are these fixes not landing?"
// triage cycle.

import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

export type VersionSkewSeverity = "engine_older" | "cli_older" | "dev_build" | "match";

export interface VersionSkewSnapshot {
  cliVersion: string;
  engineVersion: string;
  severity: VersionSkewSeverity;
}

/**
 * Pure classifier — no React. Used by the banner AND the debug-log
 * line so both surfaces report the same severity.
 *
 * Comparison strategy:
 *   - "0.0.0-dev" CLI → dev_build (operator is iterating; skew is
 *     intentional).
 *   - identical strings → match.
 *   - otherwise compare semver-style. CLI > engine → engine_older
 *     (the dominant production case: stale docker container);
 *     CLI < engine → cli_older (operator hasn't bumped sk).
 */
export function classifyVersionSkew(
  cliVersion: string,
  engineVersion: string,
): VersionSkewSnapshot {
  const cli = cliVersion.trim();
  const engine = engineVersion.trim();
  if (cli === "0.0.0-dev" || cli === "dev" || cli.endsWith("-dev")) {
    return { cliVersion: cli, engineVersion: engine, severity: "dev_build" };
  }
  if (cli === engine) {
    return { cliVersion: cli, engineVersion: engine, severity: "match" };
  }
  const cmp = compareSemver(cli, engine);
  return {
    cliVersion: cli,
    engineVersion: engine,
    severity: cmp > 0 ? "engine_older" : "cli_older",
  };
}

/** Lex-compare two semver strings. Returns >0 when `a > b`, <0 when
 *  `a < b`, 0 on equal. Tolerates extra suffix segments — purely
 *  numeric comparison up to the prefix that's numeric. */
function compareSemver(a: string, b: string): number {
  const partsA = parseSegments(a);
  const partsB = parseSegments(b);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const av = partsA[i] ?? 0;
    const bv = partsB[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function parseSegments(s: string): number[] {
  return s
    .split(/[.+-]/)
    .map((segment) => Number.parseInt(segment, 10))
    .filter((n) => Number.isFinite(n));
}

interface VersionMismatchBannerProps {
  snapshot: VersionSkewSnapshot;
}

const VersionMismatchBannerImpl: React.FC<VersionMismatchBannerProps> = ({ snapshot }) => {
  if (snapshot.severity === "match" || snapshot.severity === "dev_build") return null;
  const isEngineOlder = snapshot.severity === "engine_older";
  const glyph = isEngineOlder ? "↻" : "⚠";
  const color = isEngineOlder ? "yellow" : "red";
  const message = isEngineOlder
    ? `${glyph} engine is older than this CLI (engine v${snapshot.engineVersion} · CLI v${snapshot.cliVersion}) — restart the engine to pick up the latest fixes (local dev: \`bun run dev\`; production host: \`scripts/deploy.sh patch\`)`
    : `${glyph} CLI is older than the engine (CLI v${snapshot.cliVersion} · engine v${snapshot.engineVersion}) — upgrade sk (\`bun install -g @subkit/sk@latest\` or rebuild from source)`;
  return (
    <Box>
      <Text color={color} bold>
        {message}
      </Text>
    </Box>
  );
};

export const VersionMismatchBanner = memo(VersionMismatchBannerImpl);
VersionMismatchBanner.displayName = "VersionMismatchBanner";
