import { isDevBuild, isNewer } from "@cli-core/release/version.ts";
import type { EngineReadiness } from "../engine-client/diagnostics.ts";

export type CheckStatus = "ok" | "warn" | "blocked";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface ConfigFacts {
  path: string;
  exists: boolean;
  parses: boolean;
  profile: string;
  profileFound: boolean;
}

export function configCheck(facts: ConfigFacts): CheckResult {
  if (!facts.exists)
    return {
      name: "config",
      status: "warn",
      detail: `no config file at ${facts.path}; using flags and environment only`,
      hint: "run `subkit login --engine-url <url> --api-key <key>` to create it",
    };
  if (!facts.parses)
    return {
      name: "config",
      status: "blocked",
      detail: `${facts.path} is not valid JSON; every profile falls back to defaults`,
      hint: "fix the JSON by hand or move the file away and run `subkit login` again",
    };
  if (!facts.profileFound)
    return {
      name: "config",
      status: "warn",
      detail: `${facts.path} has no profile named "${facts.profile}"`,
      hint: "run `subkit profile list` to see the profiles, or `subkit login --profile <name>`",
    };
  return { name: "config", status: "ok", detail: `${facts.path} profile=${facts.profile}` };
}

export interface UpdateFacts {
  version: string;
  checksEnabled: boolean;
  latest: string | null;
  lastCheck: number | null;
  now: number;
}

const STALE_CHECK_MS = 7 * 86_400_000;

export function updateChannelCheck(facts: UpdateFacts): CheckResult {
  if (isDevBuild(facts.version))
    return {
      name: "update_channel",
      status: "ok",
      detail: `channel=dev version=${facts.version}; dev builds never update themselves`,
    };
  const checks = facts.checksEnabled ? "on" : "off";
  const latest = facts.latest ?? "unknown";
  const base = `channel=release version=${facts.version} latest=${latest} checks=${checks}`;
  if (facts.latest && isNewer(facts.latest, facts.version))
    return {
      name: "update_channel",
      status: "warn",
      detail: base,
      hint: `run \`subkit update\` to install ${facts.latest}`,
    };
  const stale = facts.lastCheck === null || facts.now - facts.lastCheck > STALE_CHECK_MS;
  if (facts.checksEnabled && stale)
    return {
      name: "update_channel",
      status: "warn",
      detail: `${base}; no successful update check in the last 7 days`,
      hint: "run `subkit update --check` to see whether the release server is reachable",
    };
  return { name: "update_channel", status: "ok", detail: base };
}

export function reachabilityCheck(
  health: { status: string; version: string },
  ready: EngineReadiness,
): CheckResult {
  const { database, schema } = ready.checks;
  const failing = ready.failing.length > 0 ? ready.failing.join(",") : "none";
  const ok = ready.status === "ready" && database !== "fail";
  const detail = `engine live=${health.status} ready=${ready.status} version=${health.version} database=${database} schema=${schema} failing=${failing}`;
  if (database === "fail")
    return {
      name: "reachability",
      status: "blocked",
      detail,
      hint: "the engine is up but cannot reach its database; check DATABASE_URL and PostgreSQL",
    };
  if (ready.failing.includes("lifecycle"))
    return {
      name: "reachability",
      status: "blocked",
      detail,
      hint: "the engine is shutting down or draining; wait for the restart and run doctor again",
    };
  if (database === "unknown")
    return {
      name: "reachability",
      status: ok ? "ok" : "blocked",
      detail,
      hint: "a proxy in front of the engine answered /ready without the engine's checks; the database state is not visible from here",
    };
  return { name: "reachability", status: ok ? "ok" : "blocked", detail };
}

export function agentHooksCheck(legacyFiles: readonly string[]): CheckResult {
  if (legacyFiles.length === 0)
    return {
      name: "agent_hooks",
      status: "ok",
      detail: "no hooks of the former `sk` binary",
    };
  return {
    name: "agent_hooks",
    status: "warn",
    detail: `hooks still call the removed \`sk\` binary in ${legacyFiles.join(", ")}`,
    hint: "run `subkit agent migrate-hooks` to rewrite them to `subkit agent`",
  };
}

export interface SetupFacts {
  overall_status: CheckStatus;
  summary_counts: {
    blockers: number;
    warnings: number;
    sections_blocked: number;
    sections_warn: number;
  };
}

export function setupCheck({ overall_status, summary_counts: counts }: SetupFacts): CheckResult {
  return {
    name: "setup",
    status: overall_status,
    detail: `overall=${overall_status} blockers=${counts.blockers} warnings=${counts.warnings} sections_blocked=${counts.sections_blocked} sections_warn=${counts.sections_warn}`,
    ...(overall_status !== "ok"
      ? {
          hint: "run `subkit diagnostics setup --json` (or hit GET /v1/diagnostics/setup) for the per-section detail",
        }
      : {}),
  };
}

export function worst(results: readonly CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "blocked")) return "blocked";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "ok";
}
