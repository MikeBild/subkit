// Migration helper for the step-output envelope change.
//
// Before: scope[stepId] held the raw body. A transform read `users.name`
// or `$scope.users.name`.
// After : scope[stepId] holds `{data, status_code?, headers?, duration_ms, error}`.
// Authors must now read `users.data.name` or `$scope.users.data.name`.
//
// This script finds every committed workflow in the current database,
// scans transform / branch / loop expressions and output_transform
// strings, and rewrites patterns that reference a preceding step id as
// a bare key — inserting `.data` after the step id.
//
// Runs in two modes:
//
//   bun run scripts/migrate-workflow-envelope.ts --dry-run
//   bun run scripts/migrate-workflow-envelope.ts --apply
//
// `--dry-run` prints every change it would make but touches nothing.
// `--apply` writes a NEW `workflow_versions` row per workflow with the
// rewritten dag and flips `workflows.current_version_id` to the new
// row (so history is preserved; rollback = restore the prior id).
//
// Hand-review recommended before apply. The rewriter is conservative —
// it only touches bare identifiers that MATCH a preceding step id in
// the same workflow. `$scope.<id>.X` references that already contain
// `.data` are left alone.

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../apps/engine/src/db/client.ts";
import { workflows, workflowVersions } from "../apps/engine/src/db/schema/index.ts";

interface Step {
  id?: string;
  kind?: string;
  expression?: string;
  when?: string;
  over?: string;
  [k: string]: unknown;
}

interface Dag {
  steps?: Step[];
  output_transform?: string;
  [k: string]: unknown;
}

function rewriteExpression(expr: string, stepIds: ReadonlySet<string>): string {
  if (!expr) return expr;
  let out = expr;
  for (const id of stepIds) {
    // `$scope.<id>.X` — insert `.data` unless it's already there.
    const scopeRe = new RegExp(`\\$scope\\.${id}(\\.(?!data\\b))`, "g");
    out = out.replace(scopeRe, `$scope.${id}.data$1`);
    // Bare `<id>.X` at identifier boundary — only when preceded by a
    // non-identifier character (or string start) and followed by `.`.
    // Avoid rewriting identifiers that just happen to share the name.
    const bareRe = new RegExp(`(^|[^a-zA-Z0-9_$])${id}(\\.(?!data\\b))`, "g");
    out = out.replace(bareRe, `$1${id}.data$2`);
  }
  return out;
}

interface RewritePlan {
  workflow_id: string;
  slug: string;
  version: number;
  changes: Array<{ location: string; before: string; after: string }>;
  newDag: Dag;
}

function planForDag(
  dag: Dag,
  ctx: { workflow_id: string; slug: string; version: number },
): RewritePlan | null {
  const steps = dag.steps ?? [];
  const stepIds = new Set<string>();
  const changes: RewritePlan["changes"] = [];
  const newSteps = steps.map((step) => {
    const next: Step = { ...step };
    // Targeted expression fields by step kind.
    const fields: Array<keyof Step> = ["expression", "when", "over"];
    for (const f of fields) {
      const raw = next[f];
      if (typeof raw === "string") {
        const rewritten = rewriteExpression(raw, stepIds);
        if (rewritten !== raw) {
          changes.push({
            location: `steps[id=${step.id}].${String(f)}`,
            before: raw,
            after: rewritten,
          });
          next[f] = rewritten;
        }
      }
    }
    if (step.id) stepIds.add(step.id);
    return next;
  });
  const newDag: Dag = { ...dag, steps: newSteps };
  if (typeof dag.output_transform === "string") {
    const rewritten = rewriteExpression(dag.output_transform, stepIds);
    if (rewritten !== dag.output_transform) {
      changes.push({
        location: "output_transform",
        before: dag.output_transform,
        after: rewritten,
      });
      newDag.output_transform = rewritten;
    }
  }
  if (changes.length === 0) return null;
  return { ...ctx, changes, newDag };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dry = argv.includes("--dry-run") || !apply;
  if (apply && dry && argv.includes("--dry-run")) {
    throw new Error("pass either --dry-run or --apply, not both");
  }
  const db = getDb();
  const rows = await db
    .select({
      workflow_id: workflows.id,
      slug: workflows.slug,
      version: workflowVersions.version,
      version_id: workflowVersions.id,
      tenant_id: workflows.tenant_id,
      dag: workflowVersions.dag,
    })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflows.current_version_id, workflowVersions.id))
    .where(isNull(workflows.deleted_at));
  const plans: RewritePlan[] = [];
  for (const row of rows) {
    const plan = planForDag(row.dag as Dag, {
      workflow_id: row.workflow_id,
      slug: row.slug,
      version: row.version,
    });
    if (plan) plans.push(plan);
  }
  if (plans.length === 0) {
    console.log("No workflows need rewriting — every expression already uses `.data`.");
    return;
  }
  for (const p of plans) {
    console.log(`\n--- ${p.slug} (workflow_id=${p.workflow_id}, version=${p.version}) ---`);
    for (const c of p.changes) {
      console.log(`  @ ${c.location}`);
      console.log(`    before: ${c.before}`);
      console.log(`    after : ${c.after}`);
    }
  }
  if (dry) {
    console.log("\nDry run — no changes written. Re-run with --apply to commit.");
    return;
  }
  // APPLY path: write new workflow_versions row per workflow, bump
  // current_version_id, keep prior rows for rollback.
  for (const p of plans) {
    const row = rows.find((r) => r.workflow_id === p.workflow_id)!;
    const nextVersion = p.version + 1;
    const inserted = await db
      .insert(workflowVersions)
      .values({
        workflow_id: p.workflow_id,
        tenant_id: row.tenant_id,
        version: nextVersion,
        dag: p.newDag as never,
        note: "envelope migration: insert `.data` after scope references",
      })
      .returning({ id: workflowVersions.id });
    const newVersionId = inserted[0]!.id;
    await db
      .update(workflows)
      .set({ current_version_id: newVersionId, updated_at: new Date() })
      .where(and(eq(workflows.id, p.workflow_id)));
    console.log(`\n✓ ${p.slug}: committed version ${nextVersion} (new version id ${newVersionId})`);
  }
  console.log(`\nApplied ${plans.length} workflow rewrites.`);
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
