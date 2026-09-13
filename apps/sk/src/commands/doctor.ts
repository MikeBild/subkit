// `sk doctor` — first-line operator diagnostic.
//
// Aggregates the checks an operator hits when "something is wrong":
//
//   1. Profile         — does the resolved profile have an engine_url + api_key?
//   2. Reachability    — do GET /health and GET /ready agree that the engine can serve?
//   3. Authn           — does the api_key resolve to a principal?
//   4. Setup           — what does /v1/diagnostics/setup say overall + per-section?
//   5. Schema drift    — does this engine binary's embedded migration set
//                        match the rows in `drizzle.__drizzle_migrations`?
//   6. Version match   — does the CLI version match the engine's version?
//                        Mismatches usually surface as missing routes or
//                        wire-shape drift.
//
// Output is one block per check, color-coded. Exit code:
//
//   0 = everything ok
//   1 = at least one check warned
//   2 = at least one check blocked (operator must act)
//
// Designed to drop into shell scripts: `sk doctor --json` emits a single
// JSON object so a CI gate can parse it.

import { exitCodeFor } from "@cli-core/errors";
import { isEngineError, isTransportError } from "@cli-core/errors.ts";
import { printJson } from "@cli-core/format";
import { VERSION as CLI_VERSION } from "@cli-core/version.ts";
import { defineCommand } from "citty";
import pc from "picocolors";

import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

type CheckStatus = "ok" | "warn" | "blocked";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

function statusGlyph(s: CheckStatus): string {
  if (s === "ok") return pc.green("✔");
  if (s === "warn") return pc.yellow("⚠");
  return pc.red("✘");
}

function worst(results: CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "blocked")) return "blocked";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "ok";
}

function exitCodeFromStatus(s: CheckStatus): number {
  // Warnings are advisory, not failures — a freshly-bootstrapped, correctly
  // configured engine routinely warns (e.g. no public_base_url on localhost),
  // and gating CI/onboarding scripts on a non-zero exit for that is noise.
  // Only a hard blocker is a non-zero exit.
  if (s === "blocked") return 2;
  return 0;
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Diagnose engine connectivity, authentication, and setup. Exits 0 (ok or warn) or 2 (blocked).",
  },
  args: {
    "engine-url": { type: "string", description: "Override the resolved engine URL" },
    "api-key": { type: "string", description: "Override the resolved API key" },
    profile: { type: "string", description: "Use a named profile" },
    json: { type: "boolean", description: "Emit one JSON object instead of human output" },
  },
  async run({ args }) {
    const profile = resolveProfile({
      engine_url: args["engine-url"] as string | undefined,
      api_key: args["api-key"] as string | undefined,
      profile: args.profile as string | undefined,
    });
    const results: CheckResult[] = [];

    // -------- 1. Profile --------
    const profileStatus: CheckStatus = !profile.api_key
      ? "blocked"
      : !profile.engine_url
        ? "blocked"
        : "ok";
    results.push({
      name: "profile",
      status: profileStatus,
      detail:
        profileStatus === "ok"
          ? `engine_url=${profile.engine_url} api_key=(set) tenant=${profile.active_tenant_id ?? "(none)"}`
          : !profile.api_key
            ? "no api_key configured for this profile"
            : "no engine_url configured for this profile",
      ...(profileStatus !== "ok"
        ? {
            hint: "run `sk login --engine-url <url> --api-key <key>` (or `sk init --engine-url <url> --token <bootstrap-token>` on a fresh engine; the token is printed once to engine stdout on first boot)",
          }
        : {}),
    });

    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });

    // -------- 2. Reachability --------
    let reachability: CheckResult;
    let engineVersion: string | undefined;
    try {
      const [h, ready] = await Promise.all([client.health(), client.ready()]);
      engineVersion = h.version;
      const databaseReady = ready.checks.database === "pass";
      reachability = {
        name: "reachability",
        status: ready.status === "ready" ? "ok" : "blocked",
        detail: `engine live=${h.status} ready=${ready.status} version=${h.version} database=${ready.checks.database}`,
        ...(databaseReady ? {} : { hint: "engine is up but cannot reach the database" }),
      };
    } catch (err) {
      const detail = isTransportError(err)
        ? `cannot reach engine — ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      reachability = {
        name: "reachability",
        status: "blocked",
        detail,
        hint: "verify the engine URL is correct, the engine is running, and your network can reach it",
      };
    }
    results.push(reachability);

    // -------- 3. Authn + 4. Setup --------
    // setupValidation requires a principal, so it doubles as the authn check.
    if (reachability.status === "blocked" || profileStatus === "blocked") {
      results.push({
        name: "authn",
        status: "warn",
        detail: "skipped — fix profile + reachability first",
      });
      results.push({
        name: "setup",
        status: "warn",
        detail: "skipped — fix profile + reachability first",
      });
    } else {
      try {
        const setup = await client.setupValidation();
        results.push({
          name: "authn",
          status: "ok",
          detail: "api_key resolved; principal authenticated",
        });
        const overall = setup.overall_status;
        const counts = setup.summary_counts;
        results.push({
          name: "setup",
          status: overall,
          detail: `overall=${overall} blockers=${counts.blockers} warnings=${counts.warnings} sections_blocked=${counts.sections_blocked} sections_warn=${counts.sections_warn}`,
          ...(overall !== "ok"
            ? {
                hint: "run `sk doctor --json` (or hit GET /v1/diagnostics/setup) for the per-section detail",
              }
            : {}),
        });
      } catch (err) {
        if (isEngineError(err) && err.status === 401) {
          results.push({
            name: "authn",
            status: "blocked",
            detail: `engine rejected the api_key (HTTP 401 ${err.code})`,
            hint: "rotate or re-issue the api_key; on a fresh engine, mint one with `bun run db:issue-admin-key`",
          });
          results.push({
            name: "setup",
            status: "warn",
            detail: "skipped — authn failed",
          });
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          results.push({
            name: "authn",
            status: "warn",
            detail: `unexpected error from setup endpoint: ${detail}`,
          });
          results.push({ name: "setup", status: "warn", detail: "skipped — authn warned" });
        }
      }
    }

    // -------- 5. Schema drift --------
    if (reachability.status === "blocked" || profileStatus === "blocked") {
      results.push({
        name: "schema_drift",
        status: "warn",
        detail: "skipped — fix profile + reachability first",
      });
    } else {
      // The `audit:read`-gated `/v1/diagnostics/drift` is the
      // canonical source of the actionable drift detail (the public
      // `/health` deliberately omits it to avoid leaking
      // operational posture to unauthenticated callers), so always
      // pull it. Every `sk doctor` run writes one
      // `DIAGNOSTICS_DRIFT_READ` audit row, even on a clean DB —
      // intentional, so operators searching `audit_log` for drift
      // reads see doctor invocations alongside any genuine probes.
      try {
        const report = await client.driftReport();
        const unknown = report.unknown_in_db.length;
        const historical = report.historical_in_db.length;
        const missing = report.missing_in_db.length;
        if (unknown === 0 && missing === 0) {
          results.push({
            name: "schema_drift",
            status: "ok",
            detail:
              `embedded=${report.embedded_migration_count} db=${report.db_migration_count} ` +
              `(current${historical > 0 ? `; accepted_history=${historical}` : ""})`,
          });
        } else {
          const status: CheckStatus = "blocked";
          const firstHashes = report.unknown_in_db
            .slice(0, 3)
            .map((r) => r.hash.slice(0, 12))
            .join(", ");
          results.push({
            name: "schema_drift",
            status,
            detail:
              `embedded=${report.embedded_migration_count} db=${report.db_migration_count} ` +
              `unknown_in_db=${unknown}${firstHashes ? ` (${firstHashes}…)` : ""} ` +
              `accepted_history=${historical} ` +
              `missing_in_db=${missing}`,
            hint:
              unknown > 0
                ? "DB carries migration rows from a different engine lineage. " +
                  "Pick a resolution path: (a) port the missing migration " +
                  "files into this binary's source and ship a new release, or " +
                  "(b) reset the DB from the embedded set during a maintenance window."
                : // missing_in_db > 0 with the engine running means the
                  // boot-time `runMigrations(db)` already ran (otherwise
                  // boot would have aborted) AND still observed embedded
                  // migrations the DB doesn't have. That is a silent
                  // failure of the migrator, not a stale binary — restarting
                  // does not clear it.  Operator should inspect the
                  // engine's `migrate.applied` log entries (sk logs
                  // --module db --action migrate.applied) and the
                  // missing migration's SQL for a runtime apply error.
                  "boot-time migrate ran but the DB is still missing embedded migrations — " +
                  "check `sk logs --module db --action migrate.applying` for the per-tag " +
                  "apply entries; restarting will not clear this on its own.",
          });
        }
      } catch (err) {
        if (isEngineError(err) && err.status === 404) {
          // Older engine without the drift endpoint. Fall back to the
          // health flag — we only got here because the field was missing
          // OR true; either way the operator should upgrade.
          results.push({
            name: "schema_drift",
            status: "warn",
            detail: "engine does not expose /v1/diagnostics/drift",
            hint: "upgrade the engine to a build that exposes the drift endpoint",
          });
        } else if (isEngineError(err) && err.status === 403) {
          results.push({
            name: "schema_drift",
            status: "warn",
            detail: "audit:read permission required to read drift report",
            hint: "use a key with audit:read scope (admin role) to see drift detail",
          });
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          results.push({
            name: "schema_drift",
            status: "warn",
            detail: `drift report unavailable: ${detail}`,
          });
        }
      }
    }

    // -------- 6. Version match --------
    if (engineVersion) {
      const matches = engineVersion === CLI_VERSION;
      results.push({
        name: "version_match",
        status: matches ? "ok" : "warn",
        detail: matches
          ? `cli=${CLI_VERSION} engine=${engineVersion}`
          : `cli=${CLI_VERSION} engine=${engineVersion} — versions differ`,
        ...(matches
          ? {}
          : {
              hint:
                "version mismatches usually surface as missing routes or wire-shape drift; " +
                "run `sk update` (or download a matching release) so the CLI tracks the engine",
            }),
      });
    } else {
      results.push({
        name: "version_match",
        status: "warn",
        detail: "engine version unavailable — reachability check blocked",
      });
    }

    // -------- 7. Integrations health (connectors / workflows) --------
    // The find-out-early surface: a connector pointing at a removed or
    // deprecated endpoint, a dead credential, or a workflow flagged
    // needs_attention shows up HERE — before an unattended run returns
    // "0 results". Older engines without the route degrade to a dim note.
    try {
      const integ = await client.integrationsHealth();
      const attention = integ.connectors.filter((c) => c.effective_health !== "ok");
      if (attention.length === 0 && integ.summary.workflows_attention === 0) {
        results.push({
          name: "integrations",
          status: "ok",
          detail: `${integ.summary.connectors_total} connector(s) healthy; no workflows need attention`,
        });
      } else {
        const parts: string[] = [];
        for (const c of attention.slice(0, 6)) {
          const why = c.health_error_code ?? c.effective_health;
          const extra =
            c.effective_health === "needs_update" && c.successor_uri
              ? ` → migrate to ${c.successor_uri}`
              : c.sunset_at
                ? ` (sunset ${c.sunset_at.slice(0, 10)})`
                : "";
          parts.push(`${c.slug}: ${why}${extra}`);
        }
        for (const w of integ.workflows_attention.slice(0, 4)) {
          parts.push(`workflow ${w.slug}: ${w.health_state}`);
        }
        const hasHardFault = attention.some(
          (c) => c.effective_health === "needs_reauth" || c.effective_health === "needs_update",
        );
        results.push({
          name: "integrations",
          status: hasHardFault ? "blocked" : "warn",
          detail: parts.join("; "),
          hint:
            "needs_reauth → re-authenticate the connector; needs_update → the vendor removed/deprecated " +
            "an endpoint a workflow uses (the successor URI above is the migration target); " +
            "degraded → transient vendor failures, retry later",
        });
      }
    } catch (err) {
      if (isEngineError(err) && err.status === 404) {
        results.push({
          name: "integrations",
          status: "warn",
          detail: "engine does not expose /v1/diagnostics/integrations",
          hint: "upgrade the engine to a build with the connector-health rollup",
        });
      } else if (isEngineError(err) && err.status === 403) {
        results.push({
          name: "integrations",
          status: "warn",
          detail: "connector:read (or audit:read) permission required",
        });
      } else {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ name: "integrations", status: "warn", detail: `unavailable: ${detail}` });
      }
    }

    const overall = worst(results);

    if (args.json) {
      printJson({
        overall,
        profile: {
          name: profile.name,
          engine_url: profile.engine_url,
          api_key_set: Boolean(profile.api_key),
        },
        checks: results,
      });
      process.exit(exitCodeFromStatus(overall));
    }

    // Human output.
    process.stdout.write(`\n${pc.bold("sk doctor")} · profile ${pc.cyan(profile.name)}\n`);
    process.stdout.write(`engine_url ${pc.dim(profile.engine_url)}\n\n`);
    for (const r of results) {
      process.stdout.write(`${statusGlyph(r.status)} ${pc.bold(r.name.padEnd(13))} ${r.detail}\n`);
      if (r.hint) process.stdout.write(`   ${pc.dim("↳")} ${pc.dim(r.hint)}\n`);
    }
    process.stdout.write(
      `\n${statusGlyph(overall)} overall: ${pc.bold(overall)} (exit ${exitCodeFromStatus(overall)})\n`,
    );
    process.exit(exitCodeFromStatus(overall));
  },
});
// Suppress unused warning for the error-mapping helper kept for future use.
void exitCodeFor;
