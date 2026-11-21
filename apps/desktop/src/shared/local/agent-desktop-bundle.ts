import { join } from "node:path";

export const AGENT_DESKTOP_TARGET = "darwin-arm64";
export const AGENT_DESKTOP_BINARY = "agent-desktop";
export const AGENT_DESKTOP_FILES = [AGENT_DESKTOP_BINARY, "agent-desktop-macos-helper"] as const;
export const AGENT_DESKTOP_HELPERS_DIR = "agent-desktop";

export interface CodesignDetails {
  readonly runtime: boolean;
  readonly team: string | null;
  readonly adhoc: boolean;
}

export function parseCodesignDetails(text: string): CodesignDetails {
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(text)?.[1] ?? null;
  const flags = /CodeDirectory v=\S+ size=\d+ flags=0x[0-9a-f]+\(([^)]*)\)/.exec(text);
  if (!flags) return { runtime: false, team, adhoc: false };
  const names = (flags[1] as string).split(",");
  return { runtime: names.includes("runtime"), team, adhoc: names.includes("adhoc") };
}

export function signingProblem(details: CodesignDetails, team: string): string | null {
  if (details.adhoc) return "ad hoc signature";
  if (!details.runtime) return "hardened runtime missing";
  if (details.team !== team) return `team ${details.team ?? "none"} instead of ${team}`;
  return null;
}

export function teamOfIdentity(identity: string): string | null {
  return /\(([A-Z0-9]{10})\)\s*$/.exec(identity)?.[1] ?? null;
}

export interface HelperLocation {
  readonly packaged: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly resourcesPath: string;
  readonly appRoot: string;
}

export function helperBinaryPath(location: HelperLocation): string | null {
  if (location.platform !== "darwin" || location.arch !== "arm64") return null;
  if (location.packaged) {
    return join(
      location.resourcesPath,
      "..",
      "Helpers",
      AGENT_DESKTOP_HELPERS_DIR,
      AGENT_DESKTOP_BINARY,
    );
  }
  return join(
    location.appRoot,
    "resources",
    "agent-desktop",
    AGENT_DESKTOP_TARGET,
    AGENT_DESKTOP_BINARY,
  );
}

export function agentDesktopNotice(version: string, source: string, license: string): string {
  return [
    "",
    "================================================================================",
    `agent-desktop ${version} (Apache-2.0)`,
    source,
    "The agent-desktop and agent-desktop-macos-helper binaries ship unchanged; SubKit only re-signs them.",
    "--------------------------------------------------------------------------------",
    license.trimEnd(),
    "",
  ].join("\n");
}
