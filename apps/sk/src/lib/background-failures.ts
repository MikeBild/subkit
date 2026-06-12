// Startup background-failure summary for the `sk` REPL.
//
// Scheduled workflows run unattended; when one fails the user has no
// signal beyond an `executions` row, and self-healing patch candidates
// are likewise pull-only. This builds a one-shot, best-effort banner —
// failed scheduler runs in the last 24h plus patch candidates awaiting
// review — printed once when the REPL opens. Every call is wrapped: a
// failure here must never block or slow the REPL beyond its own fetch.

import type { EngineClient } from "../engine-client.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface FailedExec {
  id: string;
  workflow_id: string | null;
  created_at: string;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Build the background-failure banner, or `null` when there is nothing
 * to report (or the lookup fails — this is decorative, never fatal).
 */
export async function backgroundFailureBanner(client: EngineClient): Promise<string | null> {
  try {
    const cutoff = Date.now() - WINDOW_MS;

    const execResp = await client.listExecutions({
      status: "failed",
      request_source: "scheduler",
      limit: 25,
    });
    // `total` is the exact all-time count of failed scheduler runs under
    // these filters — when it exceeds the scanned page, the banner says
    // so instead of presenting the page as the universe.
    const scanned = (execResp.items ?? []).length;
    const scanTruncated = execResp.total > scanned;
    const failures: FailedExec[] = [];
    for (const raw of execResp.items ?? []) {
      const id = asString(raw.id);
      const created = asString(raw.created_at);
      if (!id || !created || Date.parse(created) < cutoff) continue;
      failures.push({ id, workflow_id: asString(raw.workflow_id), created_at: created });
    }

    const patchResp = await client
      .listPatchCandidates({ status: "proposed", limit: 25 })
      .catch(() => ({ items: [] as Record<string, unknown>[] }));
    const patchCount = (patchResp.items ?? []).length;

    if (failures.length === 0 && patchCount === 0) return null;

    // Group failed runs by workflow, keeping the most recent per workflow.
    const byWorkflow = new Map<string, { count: number; latest: FailedExec }>();
    for (const f of failures) {
      const key = f.workflow_id ?? "(unknown workflow)";
      const prior = byWorkflow.get(key);
      if (!prior) {
        byWorkflow.set(key, { count: 1, latest: f });
      } else {
        prior.count += 1;
        if (Date.parse(f.created_at) > Date.parse(prior.latest.created_at)) prior.latest = f;
      }
    }

    // Resolve workflow names — decorative; fall back to ids on failure.
    const names = new Map<string, string>();
    if (byWorkflow.size > 0) {
      try {
        const wfResp = await client.listWorkflows();
        for (const raw of wfResp.items ?? []) {
          const id = asString(raw.id);
          const name = asString(raw.name);
          if (id && name) names.set(id, name);
        }
      } catch {
        /* names stay as ids */
      }
    }

    const lines: string[] = [
      scanTruncated
        ? `⚠  Background failures detected (scanned latest ${scanned} of ${execResp.total} failed scheduler runs):`
        : "⚠  Background failures detected:",
    ];
    for (const [wfId, { count, latest }] of byWorkflow) {
      const label = names.get(wfId) ?? wfId;
      let reason = "";
      try {
        const steps = await client.executionSteps(latest.id);
        const failed = (steps.items ?? []).find((s) => asString(s.status) === "failed");
        if (failed) {
          const err = failed.error as { code?: unknown; message?: unknown } | null;
          const stepKey = asString(failed.step_key);
          const msg = asString(err?.message) ?? asString(err?.code) ?? "unknown error";
          reason = stepKey ? ` — step \`${stepKey}\`: ${msg}` : ` — ${msg}`;
        }
      } catch {
        /* reason is best-effort */
      }
      const plural = count === 1 ? "" : "s";
      lines.push(
        `   • '${label}': ${count} scheduled run${plural} failed in the last 24h${reason}`,
      );
    }
    if (patchCount > 0) {
      const plural = patchCount === 1 ? "" : "s";
      lines.push(`   • ${patchCount} patch candidate${plural} awaiting review`);
    }
    lines.push("   → sk executions list --status failed   ·   sk patch-candidates list");
    return lines.join("\n");
  } catch {
    return null;
  }
}
