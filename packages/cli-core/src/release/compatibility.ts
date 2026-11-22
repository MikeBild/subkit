import { CLI_BINARY } from "./assets.ts";
import { compareVersions, isDevBuild, parseVersion } from "./version.ts";

export type EngineCompatibility = "match" | "compatible" | "cli_older" | "cli_newer" | "unknown";

export function engineCompatibility(
  cliVersion: string,
  engineVersion: string,
): EngineCompatibility {
  if (isDevBuild(cliVersion) || isDevBuild(engineVersion)) return "unknown";
  const cli = parseVersion(cliVersion);
  const engine = parseVersion(engineVersion);
  if (!cli || !engine) return "unknown";
  const order = compareVersions(cli, engine);
  if (order === 0) return "match";
  if (cli.major === engine.major && cli.minor === engine.minor) return "compatible";
  return order < 0 ? "cli_older" : "cli_newer";
}

export function isIncompatible(compatibility: EngineCompatibility): boolean {
  return compatibility === "cli_older" || compatibility === "cli_newer";
}

export function compatibilityWarning(cliVersion: string, engineVersion: string): string | null {
  const compatibility = engineCompatibility(cliVersion, engineVersion);
  const cli = cliVersion.trim();
  const engine = engineVersion.trim();
  if (compatibility === "cli_older") {
    return `${CLI_BINARY} ${cli} is older than the engine (${engine}). Run \`${CLI_BINARY} update --match-engine\`.`;
  }
  if (compatibility === "cli_newer") {
    return `${CLI_BINARY} ${cli} is newer than the engine (${engine}). Run \`${CLI_BINARY} update --match-engine\` or update the engine.`;
  }
  return null;
}
