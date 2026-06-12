// Pseudo-message builders for the conversation system prompt.
//
// Each builder returns a short, deterministic text block (or null when
// the tenant has nothing to report). The conversation loop concatenates
// the non-null blocks into the volatile prompt section — volatile so
// Anthropic's prompt cache keeps the stable base intact while the
// tenant-specific state changes per turn.
//
// The five pseudo-messages:
//
//   [TENANT STATE]    — workflow / connector / execution / audit counts
//   [RBAC SNAPSHOT]   — top N permissions the current principal holds
//   [ATTACHMENTS]     — file refs uploaded to this conversation
//   [DISCOVERY]       — recent discovery runs and how many artifacts
//   [LOADED SKILLS]   — skills already pulled via load_skill this conv

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  connectors,
  conversations,
  discoveryArtifacts,
  discoveryRuns,
  executions,
  fileLinks,
  files,
  skills as skillsTable,
  workflows,
} from "../../db/schema/index.ts";

interface TenantStateOpts {
  tenant_id: string;
  db: Db;
}

export async function buildTenantStateMessage(opts: TenantStateOpts): Promise<string | null> {
  // Soft-deleted rows must not count: a tenant whose only connector was
  // deleted is an *empty* tenant (onboarding hint should fire) and the
  // TENANT STATE numbers must match what list_* enumerates.
  const [wfCount] = await opts.db
    .select({ c: sql<number>`count(*)::int` })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, opts.tenant_id), isNull(workflows.deleted_at)));
  const [connCount] = await opts.db
    .select({ c: sql<number>`count(*)::int` })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, opts.tenant_id), isNull(connectors.deleted_at)));
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [runCount] = await opts.db
    .select({ c: sql<number>`count(*)::int` })
    .from(executions)
    .where(and(eq(executions.tenant_id, opts.tenant_id), gte(executions.created_at, cutoff)));
  const workflowsN = Number(wfCount?.c ?? 0);
  const connectorsN = Number(connCount?.c ?? 0);
  const recentRunsN = Number(runCount?.c ?? 0);
  if (workflowsN === 0 && connectorsN === 0 && recentRunsN === 0) {
    return null; // empty tenant — onboarding pseudo-message will guide instead
  }
  return [
    "[TENANT STATE]",
    `- workflows: ${workflowsN}`,
    `- connectors: ${connectorsN}`,
    `- executions (last 7d): ${recentRunsN}`,
  ].join("\n");
}

interface RbacOpts {
  principal?: { roles: string[]; scopes?: string[] } | null | undefined;
}

export function buildRbacSnapshotMessage(opts: RbacOpts): string | null {
  if (!opts.principal) return null;
  const roles = opts.principal.roles ?? [];
  const scopes = opts.principal.scopes ?? [];
  if (roles.length === 0 && scopes.length === 0) return null;
  const lines = ["[RBAC SNAPSHOT]"];
  if (roles.length > 0) {
    lines.push(`- roles: ${roles.join(", ")}`);
  }
  if (scopes.length > 0) {
    const shown = scopes.slice(0, 10);
    const tail = scopes.length > 10 ? ` (+${scopes.length - 10} more)` : "";
    lines.push(`- scopes: ${shown.join(", ")}${tail}`);
  }
  return lines.join("\n");
}

interface AttachmentsOpts {
  tenant_id: string;
  conversation_id: string;
  db: Db;
}

export async function buildAttachmentsMessage(opts: AttachmentsOpts): Promise<string | null> {
  const rows = await opts.db
    .select({ link: fileLinks, file: files })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.file_id))
    .where(
      and(
        eq(fileLinks.tenant_id, opts.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, opts.conversation_id),
      ),
    )
    .orderBy(desc(fileLinks.created_at))
    .limit(25);
  if (rows.length === 0) return null;
  const lines = [`[ATTACHMENTS] (n=${rows.length})`];
  for (const r of rows) {
    const size = r.file.size_bytes;
    const sizeKb = size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
    const slug = r.link.slug ?? r.file.filename;
    lines.push(`- ${slug}  (${r.file.filename}, ${r.file.content_type ?? "unknown"}, ${sizeKb})`);
  }
  lines.push(
    'Reference any slug in tool args via @attachment:<slug> (chat text) or { "$file": "fid_..." } (JSON). The engine resolves full content before the tool runs.',
  );
  return lines.join("\n");
}

interface DiscoveryOpts {
  tenant_id: string;
  db: Db;
}

export async function buildDiscoveryMessage(opts: DiscoveryOpts): Promise<string | null> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const runs = await opts.db
    .select({
      id: discoveryRuns.id,
      started_at: discoveryRuns.started_at,
      completed_at: discoveryRuns.completed_at,
      status: discoveryRuns.status,
    })
    .from(discoveryRuns)
    .where(and(eq(discoveryRuns.tenant_id, opts.tenant_id), gte(discoveryRuns.started_at, cutoff)))
    .orderBy(desc(discoveryRuns.started_at))
    .limit(5);
  if (runs.length === 0) return null;
  const lines = ["[DISCOVERY]"];
  for (const run of runs) {
    // tenant-filter:exempt — tenant-scoped via parent flow id; verified by caller
    const [countRow] = await opts.db
      .select({ c: sql<number>`count(*)::int` })
      .from(discoveryArtifacts)
      .where(eq(discoveryArtifacts.run_id, run.id));
    const n = Number(countRow?.c ?? 0);
    const done = run.completed_at ? "done" : run.status;
    lines.push(`- run ${run.id.slice(0, 8)} (${done}): ${n} artifact(s)`);
  }
  lines.push(
    "Use list_discovery_artifacts / get_discovery_artifact / approve_discovery_artifact to act on these.",
  );
  return lines.join("\n");
}

interface LoadedSkillsOpts {
  tenant_id: string;
  conversation_id: string;
  db: Db;
}

export async function buildLoadedSkillsMessage(opts: LoadedSkillsOpts): Promise<string | null> {
  const [row] = await opts.db
    .select({ loaded_skills: conversations.loaded_skills })
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, opts.tenant_id), eq(conversations.id, opts.conversation_id)),
    )
    .limit(1);
  const loaded = (row?.loaded_skills ?? []) as string[];
  if (loaded.length === 0) return null;
  // Look up titles for readability.
  const titleRows = await opts.db
    .select({ slug: skillsTable.slug, title: skillsTable.title })
    .from(skillsTable)
    .where(eq(skillsTable.tenant_id, opts.tenant_id));
  const slugToTitle = new Map<string, string>();
  for (const r of titleRows) {
    if (r.slug) slugToTitle.set(r.slug, r.title);
  }
  const lines = [`[LOADED SKILLS] (n=${loaded.length})`];
  for (const slug of loaded) {
    const title = slugToTitle.get(slug) ?? slug;
    lines.push(`- ${slug} — ${title}`);
  }
  return lines.join("\n");
}

interface OnboardingOpts {
  tenant_id: string;
  db: Db;
}

/** Context-aware starter hint for a new tenant or a tenant that has
 *  never run a workflow. Returns null for an experienced tenant so the
 *  prompt stays lean. */
export async function buildOnboardingHint(opts: OnboardingOpts): Promise<string | null> {
  // Live rows only — a connector the operator deleted must not make the
  // tenant look "experienced" and suppress the onboarding hint.
  const [connCount] = await opts.db
    .select({ c: sql<number>`count(*)::int` })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, opts.tenant_id), isNull(connectors.deleted_at)));
  const [wfCount] = await opts.db
    .select({ c: sql<number>`count(*)::int` })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, opts.tenant_id), isNull(workflows.deleted_at)));
  const [runCount] = await opts.db
    .select({ c: sql<number>`count(*)::int` })
    .from(executions)
    .where(eq(executions.tenant_id, opts.tenant_id));

  const connectors_n = Number(connCount?.c ?? 0);
  const workflows_n = Number(wfCount?.c ?? 0);
  const runs_n = Number(runCount?.c ?? 0);

  if (connectors_n === 0) {
    return [
      "[ONBOARDING] Fresh tenant — zero connectors yet.",
      "Guide the operator to either:",
      "- upload an OpenAPI / GraphQL spec via @file: (the engine auto-discovers connectors), or",
      "- call `start_connector_from_description` to draft a connector by hand (name, driver, base_url).",
      "Then seed credentials via the UI's secure input before anything can run.",
    ].join("\n");
  }
  if (workflows_n === 0) {
    return [
      "[ONBOARDING] Connectors present but no workflows yet.",
      "Suggest `probe_connector` against each connector to see the real response shape,",
      "then `build_workflow` (or `propose_step`+`save_workflow_draft`) to persist the first one.",
    ].join("\n");
  }
  if (runs_n === 0) {
    return [
      "[ONBOARDING] Workflows persisted but nothing has run yet.",
      "Propose `run_workflow` against a dev environment with a small payload to validate the chain.",
    ].join("\n");
  }
  // Experienced tenant — no hint needed.
  return null;
}

/** Build every pseudo-message for a given conversation context. Returns
 *  the concatenated text block (or null when all builders returned null).
 *  Consumed by the conversation loop as the volatile system-prompt tail. */
export async function buildAllPseudoMessages(opts: {
  tenant_id: string;
  conversation_id: string;
  db: Db;
  principal?: { roles: string[]; scopes?: string[] } | null | undefined;
}): Promise<string | null> {
  const blocks = await Promise.all([
    buildTenantStateMessage(opts),
    Promise.resolve(buildRbacSnapshotMessage({ principal: opts.principal ?? null })),
    buildAttachmentsMessage(opts),
    buildDiscoveryMessage(opts),
    buildLoadedSkillsMessage(opts),
    buildOnboardingHint(opts),
  ]);
  const nonNull = blocks.filter((b): b is string => typeof b === "string" && b.length > 0);
  if (nonNull.length === 0) return null;
  return nonNull.join("\n\n");
}
