import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

export type VersionSkewSeverity = "engine_older" | "cli_older" | "dev_build" | "match";

export interface VersionSkewSnapshot {
  cliVersion: string;
  engineVersion: string;
  severity: VersionSkewSeverity;
}

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
    ? `${glyph} engine is older than this CLI (engine v${snapshot.engineVersion} · CLI v${snapshot.cliVersion}) — restart the deployed engine to pick up the latest fixes (local development: \`bun run dev\`)`
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
