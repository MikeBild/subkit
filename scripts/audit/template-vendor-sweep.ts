#!/usr/bin/env bun
// Layer-3 vendor-drift sweep — proves every connector template's vendor
// surface is still live and stamps `verified_at` on the entry.
//
// Layers 1 + 2 (structural lint + cross-reference invariants) already
// run in `apps/engine/src/connectors/templates.test.ts`. They guarantee
// the JSON parses and the slugs/skills/recipes hang together — they do
// NOT touch the network. Layer 3 reaches out to the vendor.
//
// What it probes per template:
//
//   1. `base_url`                                — HEAD (falls back to GET).
//   2. `probe_endpoint` (when present)           — method + path declared in
//                                                  the template, against
//                                                  `base_url`. We do NOT send
//                                                  credentials, so a 401/403
//                                                  is recorded as "auth_required"
//                                                  not "drift" (the URL is still
//                                                  reachable).
//   3. `oauth.issuer_url`/`.well-known/openid-configuration`
//      (when `auth_type === "oauth2"` OR `oauth` block present) — GET, must
//      return JSON with the standard discovery fields.
//
// Templates with `base_url === null` (per-tenant AppSync, GCP project IDs,
// custom domains) are skipped with `status === "skipped"` and a reason.
// Templates with placeholder segments (`{tenant}`, `{cloudId}`, etc.) are
// also skipped because the resolved URL depends on operator state we
// don't have here.
//
// Discipline:
//   * Hard gate — `RUN_TEMPLATE_AUDIT=1` MUST be set. Without it the script
//     refuses to run. CI never sets the flag, so the sweep can't accidentally
//     hammer vendors during normal pipeline runs.
//   * Concurrency capped at 3 via `p-limit` and a 1s/host backoff. Every
//     request identifies as `subkit-template-audit/<engine version>` so
//     vendors can correlate the traffic.
//   * Per-vendor exponential backoff on 429/5xx (cap 30s, 4 attempts).
//   * Output is sorted by template slug — re-runs produce a byte-stable
//     report file when the vendor surface hasn't changed.
//
// Optional flags:
//   --only=<slug>[,<slug>]   Sweep just the listed templates (smoke test).
//   --dry-run                Print what would be probed; no requests fly.
//   --update-templates       After the sweep, stamp `verified_at` (UTC ISO
//                            timestamp of the run) onto every template that
//                            ended in `status === "ok"`. Off by default — the
//                            script is read-mostly so a manual review of the
//                            report can intervene before stamping.
//
// Output:
//   apps/engine/src/connectors/template-audit-report.json
//   {
//     generated_at: "2026-…Z",
//     sweep_version: 1,
//     concurrency: 3,
//     user_agent: "subkit-template-audit/<version>",
//     templates: [
//       {
//         slug, base_url, status, latency_ms,
//         base_url_check:    { status, http_status, ms, error },
//         probe_check:       { status, http_status, ms, error } | null,
//         oauth_check:       { status, http_status, ms, error } | null,
//         notes: string[],
//       },
//       …sorted by slug
//     ]
//   }

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pLimit from "p-limit";

const ROOT = resolve(import.meta.dir, "..", "..");
const TEMPLATES_PATH = resolve(ROOT, "apps/engine/src/connectors/templates.json");
const REPORT_PATH = resolve(ROOT, "apps/engine/src/connectors/template-audit-report.json");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

const CONCURRENCY = 3;
const PER_HOST_BACKOFF_MS = 1000;
const MAX_RETRIES = 4;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

type CheckStatus = "ok" | "auth_required" | "drift" | "error" | "skipped";

interface CheckResult {
  status: CheckStatus;
  http_status: number | null;
  ms: number;
  error: string | null;
  url: string;
}

interface TemplateAuditEntry {
  slug: string;
  base_url: string | null;
  status: CheckStatus;
  latency_ms: number;
  base_url_check: CheckResult | null;
  probe_check: CheckResult | null;
  oauth_check: CheckResult | null;
  notes: string[];
}

interface AuditReport {
  generated_at: string;
  sweep_version: 1;
  concurrency: number;
  user_agent: string;
  templates: TemplateAuditEntry[];
}

interface MinimalTemplate {
  slug: string;
  base_url: string | null;
  auth_type: string;
  oauth: {
    issuer_url?: string | null;
    authorization_endpoint?: string | null;
    token_endpoint?: string | null;
  } | null;
  probe_endpoint: {
    method: "GET" | "HEAD" | "POST";
    path: string;
    expected_status?: [number, number];
  } | null;
}

interface Cli {
  onlySlugs: Set<string> | null;
  dryRun: boolean;
  updateTemplates: boolean;
}

function parseArgs(argv: string[]): Cli {
  const onlySlugs = new Set<string>();
  let dryRun = false;
  let updateTemplates = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--update-templates") updateTemplates = true;
    else if (arg.startsWith("--only=")) {
      for (const s of arg.slice("--only=".length).split(",")) {
        const trimmed = s.trim();
        if (trimmed.length > 0) onlySlugs.add(trimmed);
      }
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      printUsageAndExit(2);
    }
  }
  return { onlySlugs: onlySlugs.size > 0 ? onlySlugs : null, dryRun, updateTemplates };
}

function printUsageAndExit(code: number): never {
  console.error(
    [
      "Usage: RUN_TEMPLATE_AUDIT=1 bun run scripts/audit/template-vendor-sweep.ts [flags]",
      "",
      "Flags:",
      "  --only=<slug>[,slug]   Sweep just the listed templates",
      "  --dry-run              Print intended probes; do not call vendors",
      "  --update-templates     Stamp verified_at onto every template that ended OK",
      "  -h, --help             Show this help",
    ].join("\n"),
  );
  process.exit(code);
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function loadTemplates(): MinimalTemplate[] {
  const raw = JSON.parse(readFileSync(TEMPLATES_PATH, "utf8")) as MinimalTemplate[];
  if (!Array.isArray(raw)) throw new Error(`templates.json is not an array`);
  return raw;
}

function templateIsSkippable(t: MinimalTemplate): { skip: true; reason: string } | { skip: false } {
  if (t.base_url === null) {
    return { skip: true, reason: "base_url is null (per-tenant template)" };
  }
  // Curly-brace placeholders mean the URL is parametric (Auth0 tenant,
  // Atlassian cloudId, GCP project). Probing the literal string would
  // 404 against the unresolved placeholder and skew the report.
  if (/\{[^}]+\}/.test(t.base_url)) {
    return { skip: true, reason: `base_url has placeholder segments (${t.base_url})` };
  }
  return { skip: false };
}

function isOAuthTemplate(t: MinimalTemplate): boolean {
  if (t.auth_type === "oauth2") return true;
  return t.oauth !== null && (t.oauth.issuer_url ?? "").length > 0;
}

function deriveOpenIdConfigUrl(issuer: string): string {
  // Spec: <issuer>/.well-known/openid-configuration with one slash between.
  const trimmed = issuer.replace(/\/+$/, "");
  return `${trimmed}/.well-known/openid-configuration`;
}

function joinUrl(base: string, path: string): string {
  if (path.length === 0) return base;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const baseTrimmed = base.replace(/\/+$/, "");
  const pathTrimmed = path.startsWith("/") ? path : `/${path}`;
  return `${baseTrimmed}${pathTrimmed}`;
}

function classifyStatus(httpStatus: number, expectedRange?: [number, number]): CheckStatus {
  if (expectedRange) {
    const [min, max] = expectedRange;
    if (httpStatus >= min && httpStatus <= max) return "ok";
  }
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  // We don't send credentials. A 401/403 means "the host answered, the URL
  // is real, you just can't see the body" — that's a healthy live signal.
  if (httpStatus === 401 || httpStatus === 403) return "auth_required";
  // 404 / 410 / 5xx that didn't recover → drift.
  return "drift";
}

class HostBackoff {
  // Maps hostname → next-allowed wall-clock ms. Sweep is single-process so a
  // plain Map is enough; we don't share with siblings.
  private readonly nextAllowed = new Map<string, number>();
  async wait(host: string): Promise<void> {
    const now = Date.now();
    const ready = this.nextAllowed.get(host) ?? 0;
    const delay = Math.max(0, ready - now);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    this.nextAllowed.set(host, Date.now() + PER_HOST_BACKOFF_MS);
  }
}

interface ProbeRequest {
  url: string;
  method: "GET" | "HEAD" | "POST";
  acceptJson?: boolean;
  expectedRange?: [number, number];
}

async function probeOnce(req: ProbeRequest, userAgent: string): Promise<CheckResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "user-agent": userAgent,
      accept: req.acceptJson ? "application/json" : "*/*",
    };
    const init: RequestInit = {
      method: req.method,
      headers,
      signal: controller.signal,
      redirect: "follow",
    };
    const res = await fetch(req.url, init);
    const ms = Date.now() - started;
    return {
      status: classifyStatus(res.status, req.expectedRange),
      http_status: res.status,
      ms,
      error: null,
      url: req.url,
    };
  } catch (err) {
    return {
      status: "error",
      http_status: null,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      url: req.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetry(check: CheckResult): boolean {
  if (check.status === "error") return true;
  if (check.http_status === null) return false;
  if (check.http_status === 429) return true;
  if (check.http_status >= 500 && check.http_status < 600) return true;
  return false;
}

async function probeWithBackoff(
  req: ProbeRequest,
  userAgent: string,
  hostBackoff: HostBackoff,
): Promise<CheckResult> {
  let attempt = 0;
  let last: CheckResult = {
    status: "error",
    http_status: null,
    ms: 0,
    error: "no attempt made",
    url: req.url,
  };
  let host = "";
  try {
    host = new URL(req.url).hostname;
  } catch {
    return {
      status: "error",
      http_status: null,
      ms: 0,
      error: `invalid url: ${req.url}`,
      url: req.url,
    };
  }
  while (attempt < MAX_RETRIES) {
    await hostBackoff.wait(host);
    last = await probeOnce(req, userAgent);
    if (!shouldRetry(last)) return last;
    attempt += 1;
    const backoff = Math.min(RETRY_CAP_MS, 1000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, backoff));
  }
  return last;
}

async function auditTemplate(
  t: MinimalTemplate,
  userAgent: string,
  hostBackoff: HostBackoff,
  dryRun: boolean,
): Promise<TemplateAuditEntry> {
  const notes: string[] = [];
  const skip = templateIsSkippable(t);
  if (skip.skip) {
    return {
      slug: t.slug,
      base_url: t.base_url,
      status: "skipped",
      latency_ms: 0,
      base_url_check: null,
      probe_check: null,
      oauth_check: null,
      notes: [skip.reason],
    };
  }

  const baseUrl = t.base_url as string;
  const sweepStart = Date.now();

  // 1) Base URL — HEAD first, fall back to GET if HEAD looks wrong.
  let baseCheck: CheckResult;
  if (dryRun) {
    baseCheck = {
      status: "ok",
      http_status: 0,
      ms: 0,
      error: null,
      url: baseUrl,
    };
    notes.push(`dry-run: would HEAD ${baseUrl}`);
  } else {
    baseCheck = await probeWithBackoff({ url: baseUrl, method: "HEAD" }, userAgent, hostBackoff);
    // HEAD support is uneven in the wild (405 / 501 / connection close).
    // Fall back to GET so a HEAD-hostile vendor doesn't look like drift.
    const headRejected =
      baseCheck.http_status === 405 ||
      baseCheck.http_status === 501 ||
      (baseCheck.status === "error" && /method/i.test(baseCheck.error ?? ""));
    if (headRejected) {
      notes.push(`HEAD rejected (${baseCheck.http_status ?? baseCheck.error}); retrying GET`);
      baseCheck = await probeWithBackoff({ url: baseUrl, method: "GET" }, userAgent, hostBackoff);
    }
  }

  // 2) Probe endpoint — declared method + path against base URL.
  let probeCheck: CheckResult | null = null;
  if (t.probe_endpoint) {
    const probeUrl = joinUrl(baseUrl, t.probe_endpoint.path);
    if (dryRun) {
      probeCheck = {
        status: "ok",
        http_status: 0,
        ms: 0,
        error: null,
        url: probeUrl,
      };
      notes.push(`dry-run: would ${t.probe_endpoint.method} ${probeUrl}`);
    } else {
      probeCheck = await probeWithBackoff(
        {
          url: probeUrl,
          method: t.probe_endpoint.method,
          expectedRange: t.probe_endpoint.expected_status,
        },
        userAgent,
        hostBackoff,
      );
    }
  }

  // 3) OAuth issuer discovery doc, when applicable.
  let oauthCheck: CheckResult | null = null;
  if (isOAuthTemplate(t) && t.oauth?.issuer_url) {
    const issuer = t.oauth.issuer_url;
    if (/\{[^}]+\}/.test(issuer)) {
      notes.push(`oauth.issuer_url has placeholder segments (${issuer}); skipping discovery probe`);
    } else {
      const discoveryUrl = deriveOpenIdConfigUrl(issuer);
      if (dryRun) {
        oauthCheck = {
          status: "ok",
          http_status: 0,
          ms: 0,
          error: null,
          url: discoveryUrl,
        };
        notes.push(`dry-run: would GET ${discoveryUrl}`);
      } else {
        oauthCheck = await probeWithBackoff(
          { url: discoveryUrl, method: "GET", acceptJson: true },
          userAgent,
          hostBackoff,
        );
        // OAuth2-without-OIDC providers (GitHub, Bitbucket, classic Slack
        // app installs) legitimately 404 on the discovery doc — they speak
        // OAuth2 but don't publish OIDC metadata. Don't classify that as
        // vendor drift; the issuer host responded, just not with the doc.
        // True drift on this signal is a connect-refused / 5xx / DNS error,
        // which the existing classification already catches.
        if (oauthCheck.status === "drift" && oauthCheck.http_status === 404) {
          notes.push(
            `oauth issuer ${issuer} responded but does not publish .well-known/openid-configuration (OAuth2-without-OIDC); informational`,
          );
          oauthCheck = { ...oauthCheck, status: "auth_required" };
        }
      }
    }
  }

  // Reality check on the base URL: many APIs (Stripe, GitHub, etc.) deliberately
  // 404 the bare `/v1` root because nothing is mounted there. When the
  // declared probe_endpoint succeeded (or returned auth_required), a 404 on
  // the bare base URL is informational, not drift. We downgrade it so the
  // roll-up reflects the real signal.
  if (
    baseCheck.status === "drift" &&
    baseCheck.http_status === 404 &&
    probeCheck !== null &&
    (probeCheck.status === "ok" || probeCheck.status === "auth_required")
  ) {
    notes.push(
      `base_url returned 404 but probe_endpoint reachable (${probeCheck.http_status ?? "n/a"}); treating base_url as informational`,
    );
    baseCheck = { ...baseCheck, status: "auth_required" };
  }

  // Roll-up: a template is OK only if every check that ran is OK or
  // auth_required. A single drift/error downgrades the whole template so
  // operators can sort the report by `status` and triage drift first.
  const checks = [baseCheck, probeCheck, oauthCheck].filter((c): c is CheckResult => c !== null);
  const driftOrError = checks.find((c) => c.status === "drift" || c.status === "error");
  let rollup: CheckStatus;
  if (driftOrError) {
    rollup = driftOrError.status;
  } else if (checks.every((c) => c.status === "ok")) {
    rollup = "ok";
  } else {
    // Some auth_required, some ok — still considered live.
    rollup = "auth_required";
  }

  return {
    slug: t.slug,
    base_url: baseUrl,
    status: rollup,
    latency_ms: Date.now() - sweepStart,
    base_url_check: baseCheck,
    probe_check: probeCheck,
    oauth_check: oauthCheck,
    notes,
  };
}

function writeReport(report: AuditReport): void {
  // Two-space indent, sorted-by-slug template list, trailing newline — matches
  // the rest of the JSON files in this directory and keeps re-runs deterministic.
  const sorted: AuditReport = {
    ...report,
    templates: [...report.templates].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

function stampVerifiedAtInPlace(slugs: Set<string>, isoNow: string): number {
  // Minimal-diff edit: each template object's last field is `aws_region`
  // (universal across the catalog), and `verified_at` sits immediately
  // beneath it. We rewrite that single line per slug instead of
  // re-serializing the entire JSON, which would churn every short array
  // back into multi-line form. Returns the number of templates updated.
  const original = readFileSync(TEMPLATES_PATH, "utf8");
  const lines = original.split("\n");
  let updated = 0;
  // Walk the file once, tracking the most recent slug seen; when we hit a
  // `verified_at` line that belongs to a target slug, replace it with the
  // current timestamp.
  let currentSlug: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const slugMatch = line.match(/^ {4}"slug":\s*"([^"]+)"/);
    if (slugMatch) {
      currentSlug = slugMatch[1] ?? null;
      continue;
    }
    if (currentSlug && slugs.has(currentSlug) && /^ {4}"verified_at":/.test(line)) {
      lines[i] = `    "verified_at": ${JSON.stringify(isoNow)}`;
      updated += 1;
      currentSlug = null; // verified_at is the closing field; defend against re-match
    }
  }
  writeFileSync(TEMPLATES_PATH, lines.join("\n"), "utf8");
  return updated;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (process.env.RUN_TEMPLATE_AUDIT !== "1") {
    console.error(
      "Refusing to run: RUN_TEMPLATE_AUDIT=1 is required. The sweep makes live calls\n" +
        "to vendor APIs and must never run unattended in CI. Set the env var explicitly\n" +
        "to acknowledge.",
    );
    process.exit(2);
  }

  const version = readPackageVersion();
  const userAgent = `subkit-template-audit/${version}`;
  const all = loadTemplates();
  const targets = cli.onlySlugs ? all.filter((t) => cli.onlySlugs?.has(t.slug)) : all;
  if (cli.onlySlugs && targets.length === 0) {
    console.error(
      `--only matched no templates. Known slugs (sample): ${all
        .slice(0, 5)
        .map((t) => t.slug)
        .join(", ")} …`,
    );
    process.exit(2);
  }

  console.error(
    `template-vendor-sweep: ${targets.length} templates, concurrency=${CONCURRENCY}, ua="${userAgent}"${cli.dryRun ? " (dry-run)" : ""}`,
  );

  const limit = pLimit(CONCURRENCY);
  const hostBackoff = new HostBackoff();
  const generatedAt = new Date().toISOString();
  const results = await Promise.all(
    targets.map((t) => limit(() => auditTemplate(t, userAgent, hostBackoff, cli.dryRun))),
  );

  const report: AuditReport = {
    generated_at: generatedAt,
    sweep_version: 1,
    concurrency: CONCURRENCY,
    user_agent: userAgent,
    templates: results,
  };

  // Merge into the existing report on partial sweeps (`--only`) so we don't
  // wipe the rest of the catalog. Full sweeps replace the file.
  if (cli.onlySlugs && existsSync(REPORT_PATH)) {
    try {
      const prior = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as AuditReport;
      const updatedSlugs = new Set(results.map((r) => r.slug));
      const merged = [...prior.templates.filter((t) => !updatedSlugs.has(t.slug)), ...results];
      report.templates = merged;
    } catch {
      // Fall through with the sweep-only report; better than crashing.
    }
  }

  writeReport(report);

  const tally = results.reduce<Record<CheckStatus, number>>(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { ok: 0, auth_required: 0, drift: 0, error: 0, skipped: 0 },
  );
  console.error(
    `template-vendor-sweep complete: ok=${tally.ok} auth_required=${tally.auth_required} drift=${tally.drift} error=${tally.error} skipped=${tally.skipped}`,
  );
  console.error(`report written → ${REPORT_PATH}`);

  if (cli.updateTemplates && !cli.dryRun) {
    const okSlugs = new Set(
      results.filter((r) => r.status === "ok" || r.status === "auth_required").map((r) => r.slug),
    );
    const updated = stampVerifiedAtInPlace(okSlugs, generatedAt);
    console.error(`stamped verified_at on ${updated} templates → ${TEMPLATES_PATH}`);
  }

  // Drift exits non-zero so CI invocations (when a future weekly cron lands)
  // can pipe straight into `gh issue create` without inspecting JSON. Errors
  // alone are not fatal — they may be transient network blips and the operator
  // re-runs.
  if (tally.drift > 0) {
    console.error(`drift detected on ${tally.drift} template(s); see report for details`);
    process.exit(1);
  }
}

await main();
