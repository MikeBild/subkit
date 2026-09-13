// `sk review` — one "what needs my attention" digest.
//
// Read-only fan-out over three existing engine list surfaces:
//   - pending Patch Candidates    (GET /v1/patch-candidates)
//   - proposed Skill Candidates   (GET /v1/skill-candidates?status=proposed)
//   - recent failed executions    (GET /v1/executions?status=failed)
//
// No mutations. Every approvable row carries the exact next-step
// command so the operator can act without hunting for ids. The engine
// enforces the read permissions on each call; this command only
// formats what the principal is allowed to see.

import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";

import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

interface ReviewRow {
  kind: "patch_candidate" | "skill_candidate" | "failed_execution";
  id: string;
  summary: string;
  status?: string | undefined;
  created_at?: string | undefined;
  /** The command the operator should run next, or undefined for read-only rows. */
  action?: string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const reviewCommand = defineCommand({
  meta: {
    name: "review",
    description:
      "Aggregated approval digest: pending patch candidates, proposed skill candidates, and recent failed executions.",
  },
  args: {
    limit: {
      type: "string",
      description: "Max rows per section",
      default: "10",
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    const limit = Number(args.limit) || 10;
    const jsonMode = Boolean(args.json);

    // Fan out the three list calls. Each is tolerant: a failing section
    // (e.g. the principal lacks a read scope) degrades to an empty list
    // plus a note rather than failing the whole digest.
    const notes: string[] = [];

    async function safeList(
      label: string,
      fn: () => Promise<{ items: Record<string, unknown>[] }>,
    ): Promise<Record<string, unknown>[]> {
      try {
        const { items } = await fn();
        return Array.isArray(items) ? items : [];
      } catch (err) {
        notes.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    }

    const [patchItems, skillItems, failedItems] = await Promise.all([
      safeList("patch-candidates", () => client.listPatchCandidates({ limit })),
      safeList("skill-candidates", () => client.listSkillCandidates({ limit, status: "proposed" })),
      safeList("executions", () => client.listExecutions({ limit, status: "failed" })),
    ]);

    const patchRows: ReviewRow[] = patchItems
      // Pending only — already-approved/rejected candidates are not work.
      .filter((it) => {
        const s = str(it.status);
        return s === undefined || s === "pending" || s === "proposed";
      })
      .map((it) => {
        const id = str(it.id) ?? "(unknown)";
        return {
          kind: "patch_candidate" as const,
          id,
          summary: str(it.summary) ?? str(it.workflow_id) ?? "(patch candidate)",
          status: str(it.status),
          created_at: str(it.created_at),
          action: `sk patch-candidates approve ${id}`,
        };
      });

    const skillRows: ReviewRow[] = skillItems.map((it) => {
      const id = str(it.id) ?? "(unknown)";
      return {
        kind: "skill_candidate" as const,
        id,
        summary: str(it.title) ?? str(it.source) ?? "(skill candidate)",
        status: str(it.status),
        created_at: str(it.created_at),
        action: `sk skill-candidates approve ${id}`,
      };
    });

    const failedRows: ReviewRow[] = failedItems.map((it) => {
      const id = str(it.id) ?? "(unknown)";
      return {
        kind: "failed_execution" as const,
        id,
        summary: str(it.workflow_id) ?? "(execution)",
        status: str(it.status) ?? "failed",
        created_at: str(it.started_at) ?? str(it.created_at),
        // Failed executions are not approvable; the next step is to inspect.
        action: `sk executions get ${id}`,
      };
    });

    if (jsonMode) {
      printJson({
        patch_candidates: patchRows,
        skill_candidates: skillRows,
        failed_executions: failedRows,
        total: patchRows.length + skillRows.length + failedRows.length,
        ...(notes.length > 0 ? { notes } : {}),
      });
      return;
    }

    const total = patchRows.length + skillRows.length + failedRows.length;
    if (total === 0) {
      process.stdout.write(`${pc.green("Nothing needs your attention.")} Inbox zero.\n`);
      for (const n of notes) process.stderr.write(`${pc.dim("note:")} ${n}\n`);
      return;
    }

    process.stdout.write(
      `${pc.bold("Needs your attention")} — ${total} item${total === 1 ? "" : "s"}\n`,
    );

    function section(title: string, rows: ReviewRow[], actionVerb: string): void {
      if (rows.length === 0) return;
      process.stdout.write(`\n${pc.cyan(title)} (${rows.length})\n`);
      for (const r of rows) {
        const when = r.created_at ? ` ${pc.dim(r.created_at)}` : "";
        process.stdout.write(`  ${pc.bold(r.id)}  ${r.summary}${when}\n`);
        if (r.action) {
          process.stdout.write(`    ${pc.dim(`${actionVerb}:`)} ${r.action}\n`);
        }
      }
    }

    // Prioritized: pending patches first (they fix broken workflows),
    // then proposed skills, then failed runs to triage.
    section("Pending patch candidates", patchRows, "approve");
    section("Proposed skill candidates", skillRows, "approve");
    section("Recent failed executions", failedRows, "inspect");

    for (const n of notes) process.stderr.write(`\n${pc.dim("note:")} ${n}\n`);
  },
});

export { reviewCommand };
